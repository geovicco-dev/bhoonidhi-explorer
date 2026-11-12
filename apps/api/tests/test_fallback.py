"""The fallback, the budgets and the usage line: Claude first, the local
model when Claude fails, with no network (fake backends and the SDKs' own
error types)."""
from __future__ import annotations

import asyncio
import copy
import json
import logging
import time
from datetime import UTC, datetime

import anthropic
import httpx
import openai
import pytest
from pydantic import ValidationError

from bhoonidhi_api import agent, models, sessions, tools, usage
from bhoonidhi_api.config import Settings, settings

URL = "https://api.anthropic.com/v1/messages"


def status_error(cls, status: int, message: str, headers: dict | None = None):
    response = httpx.Response(status, headers=headers or {}, request=httpx.Request("POST", URL))
    return cls(message, response=response, body=None)


def no_connection(cls=anthropic.APIConnectionError):
    return cls(request=httpx.Request("POST", URL))


class Fake:
    """A backend that gives the steps or raises the errors it is handed, in order."""

    def __init__(self, name: str, model: str, *outcomes) -> None:
        self.name, self.model = name, model
        self.outcomes = list(outcomes)
        self.seen: list[list[dict]] = []

    async def step(self, messages, specs, *, final=False):
        self.seen.append(copy.deepcopy(messages))
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome


def answer(text: str = "Done.", /, **usage_: int) -> models.Step:
    return models.Step(text, [], dict(usage_))


HAIKU_USAGE = {"input_tokens": 10, "cache_creation_input_tokens": 3000, "cache_read_input_tokens": 0,
               "output_tokens": 200}


@pytest.fixture(autouse=True)
def clean(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "sessions_db", str(tmp_path / "s.db"))
    sessions.init()
    monkeypatch.setattr(models, "STATE", models._State())
    monkeypatch.setattr(settings, "model_fallback_cooldown_s", 300)


def run(router, *steps_messages):
    async def go():
        return [await router.step(m, []) for m in steps_messages]
    return asyncio.run(go())


MSGS = [{"role": "system", "content": "s"}, {"role": "user", "content": "q"}]


# --- sorting failures -------------------------------------------------------


@pytest.mark.parametrize(("exc", "kind", "cooldown"), [
    (no_connection(), "unreachable", 300),
    (no_connection(openai.APIConnectionError), "unreachable", 300),
    (anthropic.APITimeoutError(request=httpx.Request("POST", URL)), "unreachable", 300),
    (status_error(anthropic.RateLimitError, 429, "rate limited", {"retry-after": "900"}), "rate_limited", 900),
    (status_error(anthropic.RateLimitError, 429, "rate limited", {"retry-after": "5"}), "rate_limited", 300),
    (status_error(anthropic.InternalServerError, 500, "boom"), "server", 300),
    (status_error(anthropic.APIStatusError, 529, "overloaded_error"), "server", 300),
    (status_error(anthropic.AuthenticationError, 401, "invalid x-api-key"), "key", 300),
    (status_error(anthropic.PermissionDeniedError, 403, "forbidden"), "key", 300),
    (status_error(anthropic.BadRequestError, 400, "Your credit balance is too low to access the Anthropic API."),
     "billing", 3600),
    (status_error(anthropic.BadRequestError, 400, "You have reached your specified workspace API usage limits."),
     "billing", 3600),
    (status_error(anthropic.BadRequestError, 400, "messages.1: tool_use ids must be unique"), "request", 0),
    (status_error(openai.InternalServerError, 503, "model not loaded"), "server", 300),
])
def test_each_failure_is_sorted_with_how_long_to_skip_the_provider(exc, kind, cooldown):
    failure = models.classify(exc)
    assert (failure.kind, failure.cooldown_s) == (kind, cooldown)


# --- the router -------------------------------------------------------------


def test_the_provider_answers_when_it_works():
    claude = Fake("anthropic", "claude-haiku-5-5", answer("Hi.", **HAIKU_USAGE))
    gemma = Fake("openai", "gemma")
    router = models.Router(claude, gemma)
    assert run(router, MSGS)[0].text == "Hi."
    assert gemma.seen == [] and router.switched is None
    assert models.health()["answered_by"] == "provider"


def test_a_failed_provider_hands_the_same_step_to_the_fallback_and_cools_down(monkeypatch):
    monkeypatch.setattr(settings, "model_fallback", "openai")
    claude = Fake("anthropic", "claude-haiku-5-5", no_connection())
    gemma = Fake("openai", "gemma", answer("From Gemma."))
    router = models.Router(claude, gemma)
    assert run(router, MSGS)[0].text == "From Gemma."
    assert gemma.seen == [MSGS]
    assert "no answer from the model server" in router.switched
    # The next answer goes straight to the fallback while the provider cools down.
    claude2 = Fake("anthropic", "claude-haiku-5-5")
    gemma2 = Fake("openai", "gemma", answer("Again Gemma."))
    assert run(models.Router(claude2, gemma2), MSGS)[0].text == "Again Gemma."
    assert claude2.seen == []
    health = models.health()
    assert health["answered_by"] == "fallback" and "tried again after" in health["reason"]
    # After the cooldown the provider is tried again, and a success clears the reason.
    models.STATE.skip_until = time.time() - 1
    claude3 = Fake("anthropic", "claude-haiku-5-5", answer("Claude is back."))
    assert run(models.Router(claude3, Fake("openai", "gemma")), MSGS)[0].text == "Claude is back."
    assert models.STATE.reason == "" and models.health()["answered_by"] == "provider"


def test_a_refused_request_moves_only_that_answer():
    claude = Fake("anthropic", "claude-haiku-5-5",
                  status_error(anthropic.BadRequestError, 400, "messages.1: something our code got wrong"))
    gemma = Fake("openai", "gemma", answer("From Gemma."))
    assert run(models.Router(claude, gemma), MSGS)[0].text == "From Gemma."
    # No cooldown: the next answer tries the provider again.
    claude2 = Fake("anthropic", "claude-haiku-5-5", answer("Claude."))
    assert run(models.Router(claude2, Fake("openai", "gemma")), MSGS)[0].text == "Claude."


def test_with_no_fallback_or_both_failing_no_model_can_answer():
    with pytest.raises(models.ModelUnavailable):
        run(models.Router(Fake("anthropic", "claude-haiku-5-5", no_connection()), None), MSGS)
    with pytest.raises(models.ModelUnavailable):
        run(models.Router(Fake("anthropic", "claude-haiku-5-5", no_connection()),
                          Fake("openai", "gemma", no_connection(openai.APIConnectionError))), MSGS)
    # During the cooldown with no fallback, nobody answers.
    assert models.health()["answered_by"] == "nobody"


# --- in the agent -------------------------------------------------------------


def agent_run(monkeypatch, router, question="scenes over Agra"):
    async def resolve_location(name: str) -> dict:
        return {"status": "ok", "name": name, "bbox": [77.6, 27.4, 77.7, 27.5]}

    spec = {"type": "function", "function": {"name": "resolve_location", "description": "Find a place.",
                                             "parameters": {"type": "object", "properties": {"name": {"type": "string"}},
                                                            "required": ["name"]}}}
    monkeypatch.setattr(models, "backend", lambda: router)
    monkeypatch.setattr(tools, "registry", lambda: ([spec], {"resolve_location": resolve_location}))

    async def collect():
        return [e async for e in agent.run_agent(question)]

    return asyncio.run(collect())


def test_a_failure_halfway_through_an_answer_carries_on_with_the_fallback(monkeypatch):
    blocks = [{"type": "thinking", "thinking": "Agra first.", "signature": "sig"},
              {"type": "tool_use", "id": "toolu_01", "name": "resolve_location", "input": {"name": "Agra"}}]
    claude = Fake("anthropic", "claude-haiku-5-5",
                  models.Step("", [{"id": "toolu_01", "name": "resolve_location", "arguments": '{"name": "Agra"}'}],
                              dict(HAIKU_USAGE), blocks),
                  status_error(anthropic.APIStatusError, 529, "overloaded_error"))
    gemma = Fake("openai", "gemma", answer("Found 3 scenes over Agra."))
    events = agent_run(monkeypatch, models.Router(claude, gemma))
    assert [e["type"] for e in events] == ["tool_call", "tool_result", "answer", "turn_llm"]
    assert events[2]["text"] == "Found 3 scenes over Agra."
    # Gemma got the steps already done, with the tool result, but none of Claude's thinking.
    sent = models.openai_messages(gemma.seen[0])
    assert sent[-1]["role"] == "tool" and sent[-1]["tool_call_id"] == "toolu_01"
    assert all(models.BLOCKS_KEY not in m for m in sent)


def test_a_visitor_sees_one_plain_message_when_no_model_answers(monkeypatch):
    router = models.Router(Fake("anthropic", "claude-haiku-5-5", no_connection()),
                           Fake("openai", "gemma", no_connection(openai.APIConnectionError)))
    events = agent_run(monkeypatch, router)
    assert events[0] == {"type": "error", "message": agent.UNAVAILABLE}
    assert "LLM request failed" not in json.dumps(events)


def test_each_answer_logs_one_usage_line_per_model(monkeypatch, caplog):
    claude = Fake("anthropic", "claude-haiku-5-5",
                  models.Step("", [{"id": "toolu_01", "name": "resolve_location", "arguments": '{"name": "Agra"}'}],
                              dict(HAIKU_USAGE)),
                  no_connection())
    gemma = Fake("openai", "gemma", answer("Done."))
    with caplog.at_level(logging.INFO, logger="bhoonidhi_api"):
        agent_run(monkeypatch, models.Router(claude, gemma))
    lines = [r.getMessage() for r in caplog.records if r.getMessage().startswith("model_usage")]
    assert len(lines) == 2
    assert "backend=anthropic model=claude-haiku-5-5 role=provider steps=1 input_tokens=10" in lines[0]
    assert "cache_write_tokens=3000 output_tokens=200 cost_usd=0.000476" in lines[0]
    assert "backend=openai model=gemma role=fallback steps=1" in lines[1] and "cost_usd=unknown" in lines[1]
    # Gemma's fake step reports no token counts: "unknown", not 0.
    assert "input_tokens=unknown" in lines[1] and "output_tokens=unknown" in lines[1]
    assert 'switched="no answer from the model server' in lines[1]
    # No question text in the usage line.
    assert not any("Agra" in line for line in lines)


# --- prices and budgets --------------------------------------------------------


def test_step_cost_follows_the_price_table(monkeypatch):
    # 10 fresh, 3,000 written, 200 out on Haiku 5.5: (10*0.10 + 3000*0.125 + 200*0.50) / 1e6.
    assert usage.step_cost("claude-haiku-5-5", HAIKU_USAGE) == pytest.approx(0.000476)
    assert usage.step_cost("claude-haiku-5-5", HAIKU_USAGE, cache_1h=True) == pytest.approx(0.000701)
    # A request over 100,000 tokens costs Haiku's higher price.
    big = {"input_tokens": 0, "cache_read_input_tokens": 100_001, "output_tokens": 0}
    assert usage.step_cost("claude-haiku-5-5", big) == pytest.approx(100_001 * 0.05 / 1e6)
    assert usage.step_cost("google/gemma-4-26b-a4b-qat", HAIKU_USAGE) is None
    monkeypatch.setattr(settings, "model_prices", json.dumps(
        {"gpt-x": {"in": 1, "write": 1, "write_1h": 1, "read": 1, "out": 2}}))
    assert usage.step_cost("gpt-x", {"input_tokens": 1_000_000, "output_tokens": 500_000}) == pytest.approx(2.0)


def test_each_answer_adds_its_cost_to_the_day():
    claude = Fake("anthropic", "claude-haiku-5-5", answer(**HAIKU_USAGE), answer(**HAIKU_USAGE))
    run(models.Router(claude, None), MSGS, MSGS)
    assert usage.spent().today == pytest.approx(2 * 0.000476)
    assert usage.spent().month == pytest.approx(2 * 0.000476)


def test_a_used_up_budget_sends_answers_to_the_fallback_until_the_day_ends(monkeypatch):
    monkeypatch.setattr(settings, "model_fallback", "openai")
    monkeypatch.setattr(settings, "model_budget_daily_usd", 0.001)
    usage.add(0.0012)
    claude = Fake("anthropic", "claude-haiku-5-5")
    gemma = Fake("openai", "gemma", answer("From Gemma."))
    router = models.Router(claude, gemma)
    assert run(router, MSGS)[0].text == "From Gemma." and claude.seen == []
    assert "daily budget of $0.001 reached" in router.switched
    noon = datetime(2026, 11, 12, 12, 0, tzinfo=UTC)
    usage.add(0.0012, noon)
    why, until = usage.over_budget(noon)
    assert until == datetime(2026, 11, 13, tzinfo=UTC)
    health = models.health()
    assert health["answered_by"] == "fallback" and health["spent_usd"]["daily_budget"] == 0.001


def test_a_budget_passed_halfway_through_an_answer_lets_it_finish(monkeypatch):
    monkeypatch.setattr(settings, "model_fallback", "openai")
    monkeypatch.setattr(settings, "model_budget_daily_usd", 0.0005)
    # The first step costs $0.000476 and the second takes the day past the budget.
    claude = Fake("anthropic", "claude-haiku-5-5", answer(**HAIKU_USAGE), answer(**HAIKU_USAGE),
                  answer(**HAIKU_USAGE))
    gemma = Fake("openai", "gemma", answer("From Gemma."))
    router = models.Router(claude, gemma)
    run(router, MSGS, MSGS, MSGS)
    assert len(claude.seen) == 3 and gemma.seen == [] and router.switched is None
    # The next answer starts over the budget, so the fallback takes it.
    assert run(models.Router(Fake("anthropic", "claude-haiku-5-5"), gemma), MSGS)[0].text == "From Gemma."


def test_the_monthly_budget_counts_every_day_of_the_month(monkeypatch):
    monkeypatch.setattr(settings, "model_budget_monthly_usd", 0.01)
    for day in (1, 5, 30):
        usage.add(0.004, datetime(2026, 11, day, tzinfo=UTC))
    why, until = usage.over_budget(datetime(2026, 11, 30, 23, 0, tzinfo=UTC))
    assert "monthly budget of $0.01 reached" in why and until == datetime(2026, 12, 1, tzinfo=UTC)
    # December starts afresh.
    assert usage.over_budget(datetime(2026, 12, 1, 0, 30, tzinfo=UTC)) is None


def test_with_no_budgets_nothing_is_skipped():
    usage.add(5.0)
    assert usage.over_budget() is None


# --- memory --------------------------------------------------------------------


TURNS = [
    {"role": "user", "content": "Sentinel-2 over Agra in 2025"},
    {"role": "assistant", "content": "", "tool_calls": [
        {"id": "a", "type": "function", "function": {"name": "search_catalog", "arguments": "{}"}}]},
    {"role": "tool", "tool_call_id": "a", "content": '{"count": 12}'},
    {"role": "assistant", "content": "Found 12 scenes over Agra."},
    {"role": "user", "content": "and Mathura"},
    {"role": "assistant", "content": "", "tool_calls": [
        {"id": "b", "type": "function", "function": {"name": "search_catalog", "arguments": "{}"}}]},
    {"role": "tool", "tool_call_id": "b", "content": '{"count": 7}'},
    {"role": "user", "content": "only the Ready ones"},
    {"role": "assistant", "content": "Here are 5 Ready scenes."},
]


def test_older_turns_keep_only_the_question_and_the_answer():
    assert agent.recent_history(TURNS, 0) == TURNS
    assert agent.recent_history(TURNS, 3) == TURNS
    kept = agent.recent_history(TURNS, 1)
    assert kept == [
        {"role": "user", "content": "Sentinel-2 over Agra in 2025"},
        {"role": "assistant", "content": "Found 12 scenes over Agra."},
        {"role": "user", "content": "and Mathura"},
        {"role": "assistant", "content": "(no answer)"},
        {"role": "user", "content": "only the Ready ones"},
        {"role": "assistant", "content": "Here are 5 Ready scenes."},
    ]
    # What is kept is still a valid conversation for Claude.
    _, sent = models.anthropic_messages([{"role": "system", "content": "s"}, *kept])
    roles = [m["role"] for m in sent]
    assert all(a != b for a, b in zip(roles, roles[1:], strict=False))


def test_replayed_tool_results_are_cut_to_the_setting(monkeypatch):
    monkeypatch.setattr(settings, "model_memory_result_chars", 10)
    assert agent._for_memory("x" * 11) == "x" * 10 + " …[truncated]"
    assert agent._for_memory("x" * 10) == "x" * 10


# --- settings and time limits ----------------------------------------------------


def test_settings_refuse_a_fallback_that_cannot_answer():
    with pytest.raises(ValidationError):
        Settings(model_provider="openai", model_fallback="openai")
    with pytest.raises(ValidationError):
        Settings(model_provider="anthropic", anthropic_api_key="")
    with pytest.raises(ValidationError):
        Settings(model_provider="anthropic", anthropic_api_key="k", model_fallback="openai", openai_model=" ")
    with pytest.raises(ValidationError):
        Settings(model_provider="openai", openai_base_url="", openai_model="gemma")
    with pytest.raises(ValidationError):
        Settings(model_prices='{"m": {"in": 1}}')
    ok = Settings(model_provider="anthropic", anthropic_api_key="k", model_fallback="openai", openai_model="gemma")
    assert ok.model_fallback == "openai"


def test_only_a_provider_with_a_fallback_gets_the_short_time_limit(monkeypatch):
    monkeypatch.setattr(settings, "model_provider", "anthropic")
    monkeypatch.setattr(settings, "anthropic_api_key", "k")
    alone = models.make_backend("anthropic", primary=True).client
    assert alone.max_retries == 2 and alone.timeout.read == 600
    monkeypatch.setattr(settings, "model_fallback", "openai")
    quick = models.make_backend("anthropic", primary=True).client
    assert quick.max_retries == 1 and quick.timeout.read == 20 and quick.timeout.connect == 10
    # The fallback keeps the SDK's own limits: it is the last one to ask.
    fallback = models.make_backend("openai", primary=False).client
    assert fallback.max_retries == 2 and fallback.timeout.read == 600
