"""The model backends: what each model is sent, and what comes back.

No network: a fake model stands in for the server, and the Claude reply is
built from the SDK's own types.
"""
from __future__ import annotations

import asyncio
import copy
import json

import pytest
from anthropic.types import Message
from pydantic import ValidationError

from bhoonidhi_api import agent, models, tools
from bhoonidhi_api.config import Settings, settings

AREA = {"kind": "circle", "lat": 27.4924, "lon": 77.6737, "radius_km": 10}


class FakeModel:
    """Returns the given steps in order and keeps a copy of every request."""

    name = "fake"

    def __init__(self, *steps: models.Step) -> None:
        self.steps = list(steps)
        self.seen: list[list[dict]] = []
        self.finals: list[bool] = []

    async def step(self, messages, specs, *, final=False):
        self.seen.append(copy.deepcopy(messages))
        self.finals.append(final)
        return self.steps.pop(0)


def call(name: str, args: dict, call_id: str = "call_0") -> dict:
    return {"id": call_id, "name": name, "arguments": json.dumps(args)}


def run(monkeypatch, fake: FakeModel, question: str, history=None, area=None) -> list[dict]:
    async def resolve_location(name: str) -> dict:
        return {"status": "ok", "name": name, "bbox": [77.6, 27.4, 77.7, 27.5]}

    spec = {"type": "function", "function": {"name": "resolve_location", "description": "Find a place.",
                                             "parameters": {"type": "object", "properties": {"name": {"type": "string"}},
                                                            "required": ["name"]}}}
    monkeypatch.setattr(models, "backend", lambda: fake)
    monkeypatch.setattr(tools, "registry", lambda: ([spec], {"resolve_location": resolve_location}))

    async def collect():
        return [e async for e in agent.run_agent(question, history, area)]

    return asyncio.run(collect())


HISTORY = [
    # Two earlier turns from a local model, which numbers its calls from call_0 every time.
    {"role": "user", "content": "Sentinel-1 over Agra in 2025"},
    {"role": "assistant", "content": "", "tool_calls": [
        {"id": "call_0", "type": "function", "function": {"name": "resolve_location", "arguments": '{"name": "Agra"}'}}]},
    {"role": "tool", "tool_call_id": "call_0", "content": '{"status": "ok"}'},
    {"role": "assistant", "content": "Found 12 scenes."},
    {"role": "user", "content": "and over Mathura"},
    {"role": "assistant", "content": "", "tool_calls": [
        {"id": "call_0", "type": "function", "function": {"name": "resolve_location", "arguments": '{"name": "Mathura"}'}},
        {"id": "call_1", "type": "function", "function": {"name": "resolve_location", "arguments": '{"name": "Vrindavan"}'}}]},
    {"role": "tool", "tool_call_id": "call_0", "content": '{"status": "ok"}'},
    {"role": "tool", "tool_call_id": "call_1", "content": '{"status": "ok"}'},
    {"role": "assistant", "content": ""},
]


def test_a_local_model_gets_the_same_request_as_before(monkeypatch):
    fake = FakeModel(models.Step("Done.", []))
    run(monkeypatch, fake, "Landsat 8 here in 2025", HISTORY, AREA)
    sent = models.openai_messages(fake.seen[0])
    # The area note joins the system prompt, exactly as system_prompt(area) builds it.
    assert sent == [{"role": "system", "content": agent.system_prompt(AREA)}, *HISTORY,
                    {"role": "user", "content": "Landsat 8 here in 2025"}]


def test_claude_gets_a_fixed_system_prompt_and_the_area_right_after_the_question(monkeypatch):
    fake = FakeModel(models.Step("Done.", []))
    run(monkeypatch, fake, "Landsat 8 here in 2025", HISTORY, AREA)
    system, sent = models.anthropic_messages(fake.seen[0])
    assert system == agent.system_prompt()
    assert "area of interest" not in system
    assert sent[0]["role"] != "system"
    assert sent[-2]["content"][-1] == {"type": "text", "text": "Landsat 8 here in 2025"}
    assert sent[-1] == {"role": "system", "content": agent.area_note(AREA)}


def test_tool_ids_from_a_local_model_are_renumbered_and_stay_paired():
    _, sent = models.anthropic_messages([{"role": "system", "content": "s"}, *HISTORY])
    uses = [b for m in sent if m["role"] == "assistant" for b in m["content"] if b["type"] == "tool_use"]
    assert len({b["id"] for b in uses}) == len(uses) == 3
    for i, m in enumerate(sent):
        results = [b for b in m["content"] if isinstance(m["content"], list) and b["type"] == "tool_result"]
        if results:
            # Results open their user message and answer the calls just before it.
            assert m["content"][: len(results)] == results
            asked = {b["id"] for b in sent[i - 1]["content"] if b["type"] == "tool_use"}
            assert {b["tool_use_id"] for b in results} == asked
    # Two results of one step share one message, then the next question follows in the same user turn.
    roles = [m["role"] for m in sent]
    assert all(a != b for a, b in zip(roles, roles[1:], strict=False))
    # A reply with no words is still an assistant turn.
    assert sent[-1] == {"role": "assistant", "content": [{"type": "text", "text": "(no answer)"}]}


def test_the_same_history_gives_the_same_claude_request():
    # A request that changes between steps would miss the cache every time.
    history = [{"role": "system", "content": "s"}, *HISTORY]
    assert models.anthropic_messages(history) == models.anthropic_messages(copy.deepcopy(history))


def test_claude_request_carries_caching_effort_and_thinking_and_no_temperature(monkeypatch):
    monkeypatch.setattr(settings, "anthropic_effort", "low")
    monkeypatch.setattr(settings, "anthropic_thinking", "disabled")
    request = models.anthropic_request([{"role": "system", "content": "s"}, {"role": "user", "content": "q"}], [])
    assert request["system"] == [{"type": "text", "text": "s", "cache_control": {"type": "ephemeral"}}]
    assert request["cache_control"] == {"type": "ephemeral"}
    assert request["output_config"] == {"effort": "low"}
    assert request["thinking"] == {"type": "disabled"}
    assert request["max_tokens"] == settings.anthropic_max_tokens
    assert "temperature" not in request and "tool_choice" not in request


def test_claude_defaults_send_no_effort_or_thinking_and_off_sends_no_cache(monkeypatch):
    messages = [{"role": "system", "content": "s"}, {"role": "user", "content": "q"}]
    request = models.anthropic_request(messages, [])
    assert "output_config" not in request and "thinking" not in request
    monkeypatch.setattr(settings, "anthropic_cache_ttl", "1h")
    assert models.anthropic_request(messages, [])["cache_control"] == {"type": "ephemeral", "ttl": "1h"}
    monkeypatch.setattr(settings, "anthropic_cache_ttl", "off")
    request = models.anthropic_request(messages, [])
    assert "cache_control" not in request and "cache_control" not in request["system"][0]


def test_the_wrap_up_asks_claude_for_no_more_tools():
    request = models.anthropic_request([{"role": "system", "content": "s"}, {"role": "user", "content": "q"}], [],
                                       final=True)
    assert request["tool_choice"] == {"type": "none"}


def test_strict_tools_stay_within_anthropics_limits_on_the_real_tool_specs(monkeypatch):
    monkeypatch.setattr(settings, "stac_api_url", "http://stac.test")
    monkeypatch.setattr(settings, "anthropic_strict_tools", True)
    specs, _ = tools.registry()
    # Anthropic's own 400 counted 25 optional parameters across these tools.
    assert sum(models.optional_count(s["function"]["parameters"]) for s in specs) == 25
    converted = models.anthropic_tools(specs)
    assert [t["name"] for t in converted] == [s["function"]["name"] for s in specs]
    strict = [t for t in converted if t.get("strict")]
    assert [t["name"] for t in strict] == ["resolve_location", "search_catalog", "list_collections"]
    assert sum(models.optional_count(t["input_schema"]) for t in strict) <= models.STRICT_OPTIONAL_MAX

    def objects(schema):
        if isinstance(schema, dict):
            if schema.get("type") == "object":
                yield schema
            for value in schema.values():
                yield from objects(value)
        elif isinstance(schema, list):
            for value in schema:
                yield from objects(value)

    found = [o for t in strict for o in objects(t["input_schema"])]
    assert len(found) == len(strict) + 1  # one per tool, plus date_windows' items
    assert all(o["additionalProperties"] is False for o in found)
    # A tool sent as an ordinary one keeps its schema as it was.
    plain = [t for t in converted if not t.get("strict")]
    assert [t["input_schema"] for t in plain] == [s["function"]["parameters"] for s in specs
                                                  if s["function"]["name"] == "bhd_command"]
    # The local model's specs are left as they were.
    assert all("additionalProperties" not in s["function"]["parameters"] for s in specs)

    monkeypatch.setattr(settings, "anthropic_strict_tools", False)
    loose = models.anthropic_tools(specs)
    assert all("strict" not in t for t in loose)
    assert [t["input_schema"] for t in loose] == [s["function"]["parameters"] for s in specs]


def test_strict_tools_skip_one_that_does_not_fit_and_go_on(monkeypatch):
    monkeypatch.setattr(settings, "anthropic_strict_tools", True)

    def spec(name, optional):
        props = {f"p{n}": {"type": "string"} for n in range(optional)}
        return {"type": "function", "function": {"name": name, "description": "",
                                                 "parameters": {"type": "object", "properties": props}}}

    converted = models.anthropic_tools([spec("a", 10), spec("b", 20), spec("c", 14), spec("d", 1)])
    assert [bool(t.get("strict")) for t in converted] == [True, False, True, False]
    many = models.anthropic_tools([spec(f"t{n}", 0) for n in range(models.STRICT_TOOLS_MAX + 2)])
    assert sum(1 for t in many if t.get("strict")) == models.STRICT_TOOLS_MAX


def test_a_claude_reply_becomes_a_step():
    reply = Message.model_validate({
        "id": "msg_1", "type": "message", "role": "assistant", "model": "claude-haiku-5-5",
        "content": [
            {"type": "thinking", "thinking": "The user wants Agra.", "signature": "sig-1"},
            {"type": "text", "text": "Looking up Agra."},
            {"type": "tool_use", "id": "toolu_01", "name": "resolve_location", "input": {"name": "Agra"}},
        ],
        "stop_reason": "tool_use", "stop_sequence": None,
        "usage": {"input_tokens": 52, "output_tokens": 31, "cache_read_input_tokens": 2947,
                  "cache_creation_input_tokens": 40},
    })
    step = models.anthropic_step(reply)
    assert step.text == "Looking up Agra."
    assert step.tool_calls == [{"id": "toolu_01", "name": "resolve_location", "arguments": '{"name": "Agra"}'}]
    assert step.usage == {"input_tokens": 52, "output_tokens": 31, "cache_read_input_tokens": 2947,
                          "cache_creation_input_tokens": 40}
    assert step.blocks[0] == {"type": "thinking", "thinking": "The user wants Agra.", "signature": "sig-1"}
    assert all(None not in b.values() for b in step.blocks)
    assert step.stop == "tool_use"


def test_thinking_goes_back_within_the_turn_and_is_never_stored(monkeypatch):
    blocks = [{"type": "thinking", "thinking": "Agra first.", "signature": "sig-1"},
              {"type": "tool_use", "id": "toolu_01", "name": "resolve_location", "input": {"name": "Agra"}}]
    fake = FakeModel(
        models.Step("", [call("resolve_location", {"name": "Agra"}, "toolu_01")], blocks=blocks),
        models.Step("Found 3 scenes over Agra.", []),
    )
    events = run(monkeypatch, fake, "scenes over Agra")
    assert events[-2] == {"type": "answer", "text": "Found 3 scenes over Agra."}
    # The second step sends Claude's first reply back exactly as it came.
    _, sent = models.anthropic_messages(fake.seen[1])
    assert sent[1] == {"role": "assistant", "content": blocks}
    assert sent[2]["content"][0]["tool_use_id"] == "toolu_01"
    # What the conversation keeps for the next turn holds no thinking.
    stored = events[-1]["messages"]
    assert stored and all(models.BLOCKS_KEY not in m for m in stored)
    assert stored[0]["tool_calls"][0]["id"] == "toolu_01"


def test_running_out_of_rounds_ends_with_a_final_step(monkeypatch):
    rounds = [models.Step("", [call("resolve_location", {"name": "Agra"}, f"call_{n}")]) for n in range(agent.MAX_TURNS)]
    fake = FakeModel(*rounds, models.Step("Here is what I found.", []))
    events = run(monkeypatch, fake, "scenes over Agra")
    assert fake.finals == [False] * agent.MAX_TURNS + [True]
    assert events[-2] == {"type": "answer", "text": "Here is what I found."}


def test_local_model_options_follow_the_settings(monkeypatch):
    backend = models.OpenAICompatible()
    assert backend.options() == {"temperature": 0.0}
    monkeypatch.setattr(settings, "openai_temperature", "")
    monkeypatch.setattr(settings, "openai_extra_body", '{"reasoning_effort": "none"}')
    assert backend.options() == {"extra_body": {"reasoning_effort": "none"}}


def test_settings_stop_a_bad_temperature_or_extra_body_at_start():
    with pytest.raises(ValidationError):
        Settings(openai_temperature="warm")
    with pytest.raises(ValidationError):
        Settings(openai_extra_body="[1, 2]")
    with pytest.raises(ValidationError):
        Settings(anthropic_effort="maximum")
    assert Settings(openai_temperature=" 0.2 ").openai_temperature == "0.2"


def test_the_provider_setting_chooses_the_backend(monkeypatch):
    model = models.backend()
    assert isinstance(model, models.Router) and isinstance(model.primary, models.OpenAICompatible)
    assert model.fallback is None
    monkeypatch.setattr(settings, "model_provider", "anthropic")
    monkeypatch.setattr(settings, "anthropic_api_key", "test-key")
    assert isinstance(models.backend().primary, models.Anthropic)
    monkeypatch.setattr(settings, "model_fallback", "openai")
    model = models.backend()
    assert isinstance(model.primary, models.Anthropic) and isinstance(model.fallback, models.OpenAICompatible)
