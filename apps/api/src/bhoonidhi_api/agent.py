"""The agent loop: a model calls tools until it can answer.

Yields structured events (agent text, tool call, tool result, answer, error)
for the API to stream, and finally a `turn_llm` event carrying the model
messages this turn produced, so the next turn can replay them as memory.
"""
from __future__ import annotations

import json
import re
from collections.abc import AsyncIterator
from typing import Any

from openai import AsyncOpenAI

from . import tools
from .config import settings

_BASE_PROMPT = (
    "You are the search agent for Bhoonidhi, ISRO's Earth-observation archive. "
    "Today is {today}. The user describes the imagery they want in plain language. "
    "Every search goes to the scene catalogue (search_catalog), which is updated "
    "weekly, so scenes from the last few days may not be in it yet; say so when "
    "the dates reach into the last week. "
    "Pass satellite and sensor names to the tools exactly as the user wrote "
    "them, including several names in one string ('Landsat 8 and 9'); never "
    "replace a name with one you think is meant. If a tool answers unknown_name, "
    "ask the user which of the listed satellites they meant. "
    "Call resolve_location first when they name a place. If the user names no "
    "place and there is no area on the map, ask where before searching. "
    "When you report results, use the count, by_satellite and "
    "availability_summary fields exactly as given: count may read '1,000+', "
    "which means more scenes match than the 1,000 shown. Never add up or invent "
    "numbers. Availability means: Ready = staged, downloads now; Archived = open "
    "data that must be requested on the portal before it downloads; OnOrder = "
    "must be ordered; Priced = paid. Never call an Archived scene Ready. "
    "Say how you read the question. When a word could mean several date ranges "
    "(a season, 'monsoon', 'winter', 'last few years'), state the months or "
    "dates you searched, in the answer, in words: 'the monsoon months, June to "
    "September'. The result's searched.dates says what the catalogue actually "
    "covered; repeat it rather than describing it your own way. "
    "When a word has no one meaning the data can settle ('dry periods', 'good "
    "quality', 'recent'), ask the user what they mean instead of choosing for "
    "them. Ask before searching, not after. This does NOT apply to satellite, "
    "sensor or product words: 'radar', 'optical', 'SAR', 'LISS-4', 'L2A' are "
    "resolved by the catalogue, so pass them straight to the tool and search. "
    "Only ask about a name when a tool answers unknown_name. "
    "Never let a word the catalogue cannot filter pass without saying so. No "
    "scene records {not_recorded}. If the user asks for one of these, say "
    "plainly it is not recorded and what they can do instead; mention them "
    "ONLY then, never as a list appended to an ordinary answer. A result with "
    "no scenes and a why_empty field has a known reason: give that reason, "
    "never a bare 'no scenes found'. "
    "This service never downloads. When the user wants data, call bhd_command "
    "and show the commands it returns exactly as given. Never write a download "
    "or bhd command yourself. Be concise."
)


def system_prompt(area: dict[str, Any] | None = None) -> str:
    prompt = _BASE_PROMPT.format(
        today=tools.today().isoformat(), not_recorded=tools.NOT_RECORDED,
    )
    if area:
        prompt += " " + area_note(area)
    return prompt


def area_note(area: dict[str, Any] | None) -> str:
    """The drawn area and when to use it, for the system prompt. Appended to
    the user's message instead, the model searches the drawn area even when
    the message names another place."""
    if not area:
        return ""
    name = f" ({area['name']})" if area.get("name") else ""
    if area.get("kind") == "circle":
        shape = (
            f"a circle{name} of {area['radius_km']:g} km around lat {area['lat']:.4f}, "
            f"lon {area['lon']:.4f}: pass it as lat, lon and radius_km"
        )
    else:
        shape = (
            f"a box{name}: west {area['west']:.4f}, south {area['south']:.4f}, "
            f"east {area['east']:.4f}, north {area['north']:.4f}: pass it as minx, miny, maxx, maxy"
        )
    return (
        f"The user has an area of interest on the map, {shape}. Rules for it: "
        "(1) If the user's latest message names a place (a city, district, lake, "
        "state or any other place name), that place replaces the map area: call "
        "resolve_location for it and search the box it returns. Never search the "
        "map area for a message that names a place, and never describe map-area "
        "results as another place. (2) If the message names no place, the map "
        "area is where to search, without calling resolve_location, and still "
        "apply every other filter the message asks for (satellite, sensor, "
        "dates). Call it 'the area on the map'."
    )


MAX_TURNS = 6  # tool-call rounds before forcing a final answer

# Tool results replayed as memory are cut to this size; a full scene list is
# large and the model only needs the gist of earlier searches.
MEMORY_RESULT_CHARS = 4000


async def _call(impls: dict[str, tools.Tool], name: str, args: dict[str, Any]) -> Any:
    impl = impls.get(name)
    if impl is None:
        return {"status": "error", "error": f"Unknown tool {name!r}."}
    try:
        return await impl(**args)
    except TypeError as exc:
        # The model passed arguments the tool does not take; let it correct itself.
        return {"status": "invalid_request", "error": str(exc)}
    except Exception as exc:  # noqa: BLE001 - a tool failure becomes a result the model can read
        return {"status": "error", "error": f"{type(exc).__name__}: {exc}"}


# A known model slip: a number closed with a stray quote ("maxy":25.73"). A
# value that starts as a number cannot end in a quote, so the quote goes.
_STRAY_QUOTE = re.compile(r'(:\s*-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)"(?=\s*[,}])')


def parse_arguments(raw: str) -> dict[str, Any] | None:
    """Tool-call arguments as a dict, repairing the known slip above;
    None when they still do not parse."""
    for text in (raw or "{}", _STRAY_QUOTE.sub(r"\1", raw or "{}")):
        try:
            value = json.loads(text)
        except json.JSONDecodeError:
            continue
        return value if isinstance(value, dict) else None
    return None


async def _complete(client: AsyncOpenAI, messages: list[dict], specs: list[dict]) -> tuple[str, list[dict]]:
    """One model step, streamed. Streaming matters: some servers (LM Studio
    among them) silently drop a tool call whose arguments are not valid JSON
    from a non-streamed reply, which looks like an empty answer. Returns (text, tool calls as raw dicts)."""
    stream = await client.chat.completions.create(
        model=settings.openai_model,
        messages=messages,
        tools=specs,
        tool_choice="auto",
        temperature=0,
        stream=True,
    )
    text: list[str] = []
    calls: dict[int, dict] = {}
    async for chunk in stream:
        if not chunk.choices:
            continue
        delta = chunk.choices[0].delta
        if delta.content:
            text.append(delta.content)
        for tc in delta.tool_calls or []:
            call = calls.setdefault(tc.index, {"id": "", "name": "", "arguments": ""})
            if tc.id:
                call["id"] = tc.id
            if tc.function and tc.function.name:
                call["name"] += tc.function.name
            if tc.function and tc.function.arguments:
                call["arguments"] += tc.function.arguments
    ordered = [calls[i] for i in sorted(calls)]
    for n, call in enumerate(ordered):
        call["id"] = call["id"] or f"call_{n}"
    return "".join(text), ordered


def _for_memory(content: str) -> str:
    if len(content) <= MEMORY_RESULT_CHARS:
        return content
    return content[:MEMORY_RESULT_CHARS] + " …[truncated]"


async def run_agent(
    user_message: str,
    history: list[dict[str, Any]] | None = None,
    area: dict[str, Any] | None = None,
) -> AsyncIterator[dict[str, Any]]:
    """`history` is every earlier turn as model messages: user prompts,
    assistant replies with their tool calls, and the tool results. `area` is
    the area of interest on the map when this message was sent."""
    client = AsyncOpenAI(base_url=settings.openai_base_url, api_key=settings.openai_api_key)
    specs, impls = tools.registry()
    messages: list[dict[str, Any]] = [{"role": "system", "content": system_prompt(area)}]
    messages.extend(history or [])
    messages.append({"role": "user", "content": user_message})
    produced_from = len(messages)

    def produced() -> list[dict[str, Any]]:
        out = []
        for m in messages[produced_from:]:
            if m.get("role") == "tool":
                m = {**m, "content": _for_memory(m.get("content", ""))}
            out.append(m)
        return out

    for _turn in range(MAX_TURNS):
        try:
            text, tool_calls = await _complete(client, messages, specs)
        except Exception as exc:  # noqa: BLE001 - network / model error
            yield {"type": "error", "message": f"LLM request failed: {exc}"}
            yield {"type": "turn_llm", "messages": produced()}
            return

        if not tool_calls:
            messages.append({"role": "assistant", "content": text})
            yield {"type": "answer", "text": text}
            yield {"type": "turn_llm", "messages": produced()}
            return

        parsed = [parse_arguments(tc["arguments"]) for tc in tool_calls]
        messages.append(
            {
                "role": "assistant",
                "content": text,
                "tool_calls": [
                    {
                        "id": tc["id"],
                        "type": "function",
                        "function": {
                            "name": tc["name"],
                            # Store the repaired form so replayed memory is valid JSON.
                            "arguments": json.dumps(args) if args is not None else tc["arguments"],
                        },
                    }
                    for tc, args in zip(tool_calls, parsed, strict=True)
                ],
            }
        )

        for tc, args in zip(tool_calls, parsed, strict=True):
            name = tc["name"]
            if args is None:
                # Not shown to the user; the model reads the error and resends.
                result: Any = {
                    "status": "invalid_request",
                    "error": f"Arguments were not valid JSON: {tc['arguments'][:300]}. Send the call again.",
                }
            else:
                yield {"type": "tool_call", "name": name, "arguments": args}
                result = await _call(impls, name, args)
                yield {"type": "tool_result", "name": name, "result": result}

            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": tc["id"],
                    # The browser gets every scene; the model a summary and a sample.
                    "content": tools.for_model(name, result),
                }
            )

    # Ran out of rounds; ask for a wrap-up without tools.
    try:
        final = await client.chat.completions.create(
            model=settings.openai_model,
            messages=messages + [
                {"role": "user", "content": "Summarize the results for me now, no more tools."}
            ],
            temperature=0,
        )
        text = final.choices[0].message.content or ""
        messages.append({"role": "assistant", "content": text})
        yield {"type": "answer", "text": text}
    except Exception as exc:  # noqa: BLE001
        yield {"type": "error", "message": f"final summary failed: {exc}"}
    yield {"type": "turn_llm", "messages": produced()}
