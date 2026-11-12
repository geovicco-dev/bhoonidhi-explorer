"""The model behind the agent, one step at a time.

The agent keeps one conversation format, OpenAI-style chat messages, which is
also what sessions.db stores. A backend turns that list into its server's
request, runs one model step and returns what the agent needs: the text, the
tool calls (arguments as JSON text, which agent.parse_arguments reads) and
the token usage.

- OpenAICompatible: LM Studio, Ollama, llama.cpp, vLLM or OpenAI itself.
- Anthropic: Claude through Anthropic's own Messages API, for its prompt
  caching, effort and thinking settings (and strict tool arguments, off by
  default).
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Protocol

import anthropic
import openai
from anthropic import AsyncAnthropic
from openai import AsyncOpenAI

from . import usage
from .config import settings

log = logging.getLogger("bhoonidhi_api")

# Marks the system message the agent puts right after the user's question to
# describe the area on the map for this turn. Each backend puts that note
# where its model expects it.
AREA_KEY = "area_note"
# Holds a step's output exactly as the server returned it, to be sent back
# unchanged within the same turn: Claude requires its thinking blocks back
# with each tool result. Never stored, so the next turn starts without them.
BLOCKS_KEY = "provider_blocks"


@dataclass
class Step:
    """One model step: the text written, the tools called and the tokens used."""

    text: str
    tool_calls: list[dict[str, str]]  # {"id", "name", "arguments"}
    usage: dict[str, int] = field(default_factory=dict)
    blocks: list[dict[str, Any]] | None = None
    stop: str | None = None


class Backend(Protocol):
    name: str
    model: str

    async def step(self, messages: list[dict], specs: list[dict], *, final: bool = False) -> Step:
        """One model step. `final` asks for an answer with no more tool calls."""
        ...


def make_backend(provider: str, *, primary: bool) -> Backend:
    """One provider's backend. With a fallback set, the provider tried first
    gets a short limit on silence and one retry, so a failure reaches the
    fallback in seconds; otherwise the SDKs' own limits apply."""
    quick = primary and bool(settings.model_fallback)
    # Each SDK takes its own Timeout type (the anthropic SDK runs on httpx2).
    timeout_type = anthropic.Timeout if provider == "anthropic" else openai.Timeout
    options: dict[str, Any] = {}
    if quick:
        options = {"timeout": timeout_type(settings.model_first_token_timeout_s, connect=10.0), "max_retries": 1}
    return Anthropic(**options) if provider == "anthropic" else OpenAICompatible(**options)


def backend() -> Router:
    """The model for one answer: MODEL_PROVIDER, and MODEL_FALLBACK when it fails."""
    fallback = make_backend(settings.model_fallback, primary=False) if settings.model_fallback else None
    return Router(make_backend(settings.model_provider, primary=True), fallback)


# --- OpenAI-compatible servers --------------------------------------------


def openai_messages(messages: list[dict]) -> list[dict]:
    """The messages as an OpenAI-compatible server takes them. The area note
    joins the system prompt: local models given it as a message of its own
    searched the drawn area even when the question named another place."""
    notes = [m["content"] for m in messages if m.get(AREA_KEY)]
    out = []
    for m in messages:
        if m.get(AREA_KEY):
            continue
        if m.get("role") == "system" and not out and notes:
            m = {**m, "content": " ".join([m["content"], *notes])}
        out.append({k: v for k, v in m.items() if k != BLOCKS_KEY})
    return out


class OpenAICompatible:
    name = "openai"

    def __init__(self, **options: Any) -> None:
        self.model = settings.openai_model
        # The SDK refuses an empty key, and local servers that need none ignore whatever is sent.
        self.client = AsyncOpenAI(base_url=settings.openai_base_url, api_key=settings.openai_api_key or "none",
                                  **options)

    def options(self) -> dict[str, Any]:
        options: dict[str, Any] = {}
        if settings.openai_temperature:
            options["temperature"] = float(settings.openai_temperature)
        if settings.openai_extra_body:
            options["extra_body"] = json.loads(settings.openai_extra_body)
        return options

    async def step(self, messages: list[dict], specs: list[dict], *, final: bool = False) -> Step:
        sent = openai_messages(messages)
        if final:
            reply = await self.client.chat.completions.create(model=settings.openai_model, messages=sent, **self.options())
            return Step(reply.choices[0].message.content or "", [], _openai_usage(reply.usage))
        # Streamed on purpose: some servers (LM Studio among them) silently drop
        # a tool call whose arguments are not valid JSON from a non-streamed
        # reply, which looks like an empty answer.
        stream = await self.client.chat.completions.create(
            model=settings.openai_model,
            messages=sent,
            tools=specs,
            tool_choice="auto",
            stream=True,
            **self.options(),
        )
        text: list[str] = []
        calls: dict[int, dict[str, str]] = {}
        stop = None
        async for chunk in stream:
            if not chunk.choices:
                continue
            choice = chunk.choices[0]
            stop = choice.finish_reason or stop
            delta = choice.delta
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
        return Step("".join(text), ordered, stop=stop)


def _openai_usage(usage: Any) -> dict[str, int]:
    if usage is None:
        return {}
    return {"input_tokens": usage.prompt_tokens or 0, "output_tokens": usage.completion_tokens or 0}


# --- Claude through Anthropic's Messages API -------------------------------


def anthropic_messages(messages: list[dict[str, Any]]) -> tuple[str, list[dict[str, Any]]]:
    """(system prompt, messages) in the Messages API's shape.

    - The first system message becomes the top-level system prompt; the area
      note stays a system message of its own right after the question, so the
      cached start of the request is the same whatever the area.
    - Tool results become tool_result blocks in a user message, several
      results of one step in one message.
    - A step from this turn goes back exactly as Claude returned it (thinking
      included). Earlier turns are rebuilt from text and tool calls, with tool
      ids renumbered: ids written by a local model repeat across turns, which
      Anthropic refuses. The numbering only depends on the history, so the
      same history gives the same request and keeps the cache valid.
    """
    system = ""
    out: list[dict[str, Any]] = []
    ids: dict[str, str] = {}
    renumbered = 0

    def add_user_blocks(blocks: list[dict[str, Any]]) -> None:
        last = out[-1] if out else None
        if last and last["role"] == "user":
            last["content"].extend(blocks)
        else:
            out.append({"role": "user", "content": blocks})

    for m in messages:
        role = m.get("role")
        if role == "system":
            if m.get(AREA_KEY) or out:
                out.append({"role": "system", "content": m.get("content") or ""})
            else:
                system = m.get("content") or ""
        elif role == "user":
            add_user_blocks([{"type": "text", "text": m.get("content") or " "}])
        elif role == "assistant":
            if m.get(BLOCKS_KEY):
                out.append({"role": "assistant", "content": m[BLOCKS_KEY]})
                continue
            blocks: list[dict[str, Any]] = []
            if (m.get("content") or "").strip():
                blocks.append({"type": "text", "text": m["content"]})
            for tc in m.get("tool_calls") or []:
                renumbered += 1
                ids[tc["id"]] = new_id = f"toolu_h{renumbered:03d}"
                try:
                    args = json.loads(tc["function"].get("arguments") or "{}")
                except json.JSONDecodeError:
                    args = {}
                blocks.append({"type": "tool_use", "id": new_id, "name": tc["function"]["name"],
                               "input": args if isinstance(args, dict) else {}})
            # An empty reply (a model that stopped without a word) still has to be a turn.
            out.append({"role": "assistant", "content": blocks or [{"type": "text", "text": "(no answer)"}]})
        elif role == "tool":
            tool_id = m.get("tool_call_id") or ""
            add_user_blocks([{"type": "tool_result", "tool_use_id": ids.get(tool_id, tool_id),
                              "content": m.get("content") or ""}])
    return system, out


def _closed(schema: Any) -> Any:
    """The schema with additionalProperties: false on every object, which
    strict tool use requires."""
    if isinstance(schema, list):
        return [_closed(v) for v in schema]
    if not isinstance(schema, dict):
        return schema
    out = {k: _closed(v) for k, v in schema.items()}
    if out.get("type") == "object":
        out.setdefault("additionalProperties", False)
    return out


# Anthropic compiles a request's strict tools into one grammar and refuses
# more than 20 strict tools, or 24 optional parameters across them
# (structured outputs, "Schema complexity limits").
STRICT_TOOLS_MAX = 20
STRICT_OPTIONAL_MAX = 24


def optional_count(schema: Any) -> int:
    """Parameters not listed in their object's `required`, nested ones included."""
    if isinstance(schema, list):
        return sum(optional_count(v) for v in schema)
    if not isinstance(schema, dict):
        return 0
    count = 0
    if isinstance(schema.get("properties"), dict):
        required = set(schema.get("required") or [])
        count += sum(1 for name in schema["properties"] if name not in required)
    return count + sum(optional_count(v) for v in schema.values())


def anthropic_tools(specs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Tools in the Messages API's shape. With strict tools on, each tool in
    the registry's order is made strict while the limits allow; one that
    would pass them is sent as an ordinary tool, whose arguments the agent
    still checks and repairs as it does for a local model."""
    tools = []
    strict, optional = 0, 0
    for spec in specs:
        fn = spec["function"]
        schema = fn.get("parameters") or {"type": "object", "properties": {}}
        tool: dict[str, Any] = {"name": fn["name"], "description": fn.get("description", ""), "input_schema": schema}
        extra = optional_count(schema)
        if settings.anthropic_strict_tools and strict < STRICT_TOOLS_MAX and optional + extra <= STRICT_OPTIONAL_MAX:
            tool["input_schema"] = _closed(schema)
            tool["strict"] = True
            strict, optional = strict + 1, optional + extra
        tools.append(tool)
    return tools


def anthropic_request(messages: list[dict[str, Any]], specs: list[dict[str, Any]], *, final: bool = False) -> dict[str, Any]:
    """The Messages API request for one step.

    Caching uses two marks: one at the end of the system prompt, so every
    conversation shares the cached tools and instructions, and one that
    follows the end of the conversation, so each later step of a question
    reads everything before it from the cache.
    """
    system, sent = anthropic_messages(messages)
    cache = None if settings.anthropic_cache_ttl == "off" else {"type": "ephemeral"}
    if cache and settings.anthropic_cache_ttl == "1h":
        cache["ttl"] = "1h"
    system_block: dict[str, Any] = {"type": "text", "text": system}
    if cache:
        system_block["cache_control"] = cache
    request: dict[str, Any] = {
        "model": settings.anthropic_model,
        "max_tokens": settings.anthropic_max_tokens,
        "system": [system_block],
        "messages": sent,
        "tools": anthropic_tools(specs),
    }
    if cache:
        request["cache_control"] = cache
    if final:
        request["tool_choice"] = {"type": "none"}
    if settings.anthropic_effort:
        request["output_config"] = {"effort": settings.anthropic_effort}
    if settings.anthropic_thinking:
        request["thinking"] = {"type": settings.anthropic_thinking}
    return request


def anthropic_step(reply: Any) -> Step:
    """A Step from a Messages API reply."""
    text = "".join(b.text for b in reply.content if b.type == "text")
    calls = [{"id": b.id, "name": b.name, "arguments": json.dumps(b.input)}
             for b in reply.content if b.type == "tool_use"]
    u = reply.usage
    usage = {
        "input_tokens": u.input_tokens or 0,
        "output_tokens": u.output_tokens or 0,
        "cache_read_input_tokens": u.cache_read_input_tokens or 0,
        "cache_creation_input_tokens": u.cache_creation_input_tokens or 0,
    }
    blocks = [b.model_dump(exclude_none=True) for b in reply.content]
    return Step(text, calls, usage, blocks, reply.stop_reason)


class Anthropic:
    name = "anthropic"

    def __init__(self, **options: Any) -> None:
        self.model = settings.anthropic_model
        options["api_key"] = settings.anthropic_api_key
        if settings.anthropic_base_url:
            options["base_url"] = settings.anthropic_base_url
        self.client = AsyncAnthropic(**options)

    async def step(self, messages: list[dict], specs: list[dict], *, final: bool = False) -> Step:
        async with self.client.messages.stream(**anthropic_request(messages, specs, final=final)) as stream:
            reply = await stream.get_final_message()
        return anthropic_step(reply)


# --- the fallback -----------------------------------------------------------


class ModelUnavailable(RuntimeError):
    """No model could answer. The message is for the log, never the visitor."""


@dataclass
class Failure:
    kind: str  # unreachable, rate_limited, server, key, billing, request
    reason: str
    cooldown_s: float  # how long new questions skip the provider; 0 for this question only


_BILLING_WORDS = ("credit balance", "usage limit", "spend limit", "billing", "insufficient_quota", "quota")


def classify(exc: BaseException) -> Failure:
    """What kind of failure an SDK error is, by its HTTP status (both SDKs give one)."""
    status = getattr(exc, "status_code", None)
    cooldown = settings.model_fallback_cooldown_s
    text = str(exc)
    if status is None:
        return Failure("unreachable", f"no answer from the model server ({type(exc).__name__})", cooldown)
    if status == 429:
        retry_after = None
        response = getattr(exc, "response", None)
        if response is not None:
            try:
                retry_after = float(response.headers.get("retry-after", ""))
            except ValueError:
                retry_after = None
        return Failure("rate_limited", "rate limited", max(cooldown, retry_after or 0))
    if status >= 500:
        return Failure("server", f"the model server failed ({status})", cooldown)
    if status in (401, 403):
        return Failure("key", f"the API key was refused ({status})", cooldown)
    if any(word in text.lower() for word in _BILLING_WORDS):
        # Re-tried hourly, so new credit or a raised limit is picked up within the hour.
        return Failure("billing", f"out of credit or over the provider's spend limit ({status})", max(cooldown, 3600))
    return Failure("request", f"the request was refused ({status}): {text[:200]}", 0)


@dataclass
class _State:
    """Shared by every answer: when the provider is next tried, and why not now."""
    skip_until: float = 0.0  # time.time()
    reason: str = ""
    kind: str = ""


STATE = _State()


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, UTC).isoformat(timespec="seconds")


def _note_failure(failed: Backend, failure: Failure, exc: BaseException) -> None:
    if failure.cooldown_s > 0:
        STATE.skip_until = time.time() + failure.cooldown_s
        STATE.reason, STATE.kind = failure.reason, failure.kind
        until = f"; {failed.name} is tried again after {_iso(STATE.skip_until)}"
    else:
        until = "; this question only"
    level = logging.ERROR if failure.kind in ("key", "request") else logging.WARNING
    log.log(level, "model %s (%s) failed, %s: %s%s", failed.name, failed.model, failure.kind, exc, until)


def _note_recovered(ok: Backend) -> None:
    if STATE.reason:
        log.warning("model %s (%s) answers again after: %s", ok.name, ok.model, STATE.reason)
        STATE.skip_until, STATE.reason, STATE.kind = 0.0, "", ""


def _skipped_because(*, budget: bool = True) -> str | None:
    """Why the provider is not tried right now, if it is not. The budgets are
    checked when an answer starts only, so an answer that passes one is
    finished by the same model."""
    if STATE.skip_until > time.time():
        return f"{STATE.reason} (tried again after {_iso(STATE.skip_until)})"
    over = usage.over_budget() if budget else None
    if over is not None:
        return f"{over[0]} (until {over[1].isoformat(timespec='seconds')})"
    return None


def health() -> dict[str, Any]:
    """What /health says about the model."""
    why = _skipped_because()
    out: dict[str, Any] = {
        "provider": settings.model_provider,
        "provider_model": settings.anthropic_model if settings.model_provider == "anthropic" else settings.openai_model,
        "fallback": settings.model_fallback or None,
        "answered_by": "provider" if why is None else ("fallback" if settings.model_fallback else "nobody"),
    }
    if settings.model_fallback:
        out["fallback_model"] = (settings.anthropic_model if settings.model_fallback == "anthropic"
                                 else settings.openai_model)
    if why is not None:
        out["reason"] = why
    if settings.model_budget_daily_usd > 0 or settings.model_budget_monthly_usd > 0:
        s = usage.spent()
        out["spent_usd"] = {"today": round(s.today, 4), "month": round(s.month, 4),
                            "daily_budget": settings.model_budget_daily_usd or None,
                            "monthly_budget": settings.model_budget_monthly_usd or None}
    return out


@dataclass
class _Used:
    model: str
    steps: int = 0
    tokens: dict[str, int] = field(default_factory=dict)
    cost: float = 0.0
    priced: bool = True


class Router:
    """One answer's model: MODEL_PROVIDER first; on a failure, or while it is
    cooling down or over budget, MODEL_FALLBACK. Once an answer has moved to
    the fallback it stays there, carrying on from the steps already done."""

    def __init__(self, primary: Backend, fallback: Backend | None) -> None:
        self.primary, self.fallback = primary, fallback
        self.name, self.model = primary.name, primary.model
        self.switched: str | None = None  # why this answer moved to the fallback
        self.used: dict[str, _Used] = {}

    async def step(self, messages: list[dict], specs: list[dict], *, final: bool = False) -> Step:
        if self.switched is None:
            why = await _to_thread(lambda: _skipped_because(budget=not self.used))
            if why is None:
                try:
                    step = await self.primary.step(messages, specs, final=final)
                except Exception as exc:  # noqa: BLE001 - every failure is sorted and logged
                    failure = classify(exc)
                    _note_failure(self.primary, failure, exc)
                    if self.fallback is None:
                        raise ModelUnavailable(failure.reason) from exc
                    why = failure.reason
                else:
                    _note_recovered(self.primary)
                    await self._count(self.primary, step)
                    return step
            elif self.fallback is None:
                raise ModelUnavailable(why)
            self.switched = why
            assert self.fallback is not None
            log.warning("answering with %s (%s): %s", self.fallback.name, self.fallback.model, why)
        assert self.fallback is not None
        try:
            step = await self.fallback.step(messages, specs, final=final)
        except Exception as exc:  # noqa: BLE001
            log.error("model %s (%s), the fallback, failed too: %s", self.fallback.name, self.fallback.model, exc)
            raise ModelUnavailable(f"provider: {self.switched}; fallback: {exc}") from exc
        await self._count(self.fallback, step)
        return step

    async def _count(self, b: Backend, step: Step) -> None:
        used = self.used.setdefault(b.name, _Used(b.model))
        used.steps += 1
        for k, v in step.usage.items():
            used.tokens[k] = used.tokens.get(k, 0) + v
        cost = usage.step_cost(b.model, step.usage, cache_1h=b.name == "anthropic" and settings.anthropic_cache_ttl == "1h")
        if cost is None:
            used.priced = False
        else:
            used.cost += cost
            await _to_thread(usage.add, cost)

    def log_usage(self) -> None:
        """One line per model that answered: what this answer used and cost.
        A server that reports no token counts (LM Studio when streaming) shows
        "unknown" rather than 0."""
        for name, u in self.used.items():
            t = u.tokens

            def count(key: str, t: dict = t) -> str:
                return str(t.get(key, 0)) if t else "unknown"

            log.info(
                "model_usage backend=%s model=%s role=%s steps=%d input_tokens=%s cache_read_tokens=%s "
                "cache_write_tokens=%s output_tokens=%s cost_usd=%s switched=%s",
                name, u.model, "provider" if name == self.primary.name else "fallback", u.steps,
                count("input_tokens"), count("cache_read_input_tokens"), count("cache_creation_input_tokens"),
                count("output_tokens"), f"{u.cost:.6f}" if u.priced else "unknown",
                json.dumps(self.switched) if self.switched else "no",
            )


async def _to_thread(fn, *args):
    """SQLite reads and writes off the event loop (budgets, spend)."""
    return await asyncio.to_thread(fn, *args)
