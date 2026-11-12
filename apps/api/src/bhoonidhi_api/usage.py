"""What the model costs: the price table, the cost of one step, and the
app's own daily and monthly budgets (MODEL_BUDGET_DAILY_USD and
MODEL_BUDGET_MONTHLY_USD), counted in sessions.db so a restart keeps them.

Days and months are UTC. A local model costs nothing here unless
MODEL_PRICES gives it a price.
"""
from __future__ import annotations

import json
import logging
import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from . import sessions
from .config import settings

log = logging.getLogger("bhoonidhi_api")

# US dollars per million tokens, from platform.claude.com/docs/en/about-claude/pricing
# (read 2026-11-11). "write" is a 5-minute cache write, "write_1h" a 1-hour one,
# "read" a cache hit. Haiku 5.5 costs more for a request over 100,000 tokens.
PRICES: dict[str, dict[str, Any]] = {
    "claude-haiku-5-5": {
        "in": 0.10, "write": 0.125, "write_1h": 0.20, "read": 0.01, "out": 0.50,
        "over_tokens": 100_000,
        "over": {"in": 0.50, "write": 0.625, "write_1h": 1.00, "read": 0.05, "out": 2.50},
    },
    "claude-sonnet-5-5": {"in": 2.00, "write": 2.50, "write_1h": 4.00, "read": 0.10, "out": 10.00},
    "claude-opus-5-5": {"in": 4.00, "write": 5.00, "write_1h": 8.00, "read": 0.20, "out": 20.00},
    "claude-fable-5-2": {"in": 8.00, "write": 10.00, "write_1h": 16.00, "read": 0.20, "out": 40.00},
}


def prices() -> dict[str, dict[str, Any]]:
    """The built-in table with MODEL_PRICES over it."""
    return {**PRICES, **(json.loads(settings.model_prices) if settings.model_prices else {})}


_unpriced: set[str] = set()


def step_cost(model: str, usage: dict[str, int], *, cache_1h: bool = False) -> float | None:
    """The cost of one step in US dollars, or None for a model with no price."""
    price = prices().get(model)
    if price is None:
        budgets = settings.model_budget_daily_usd > 0 or settings.model_budget_monthly_usd > 0
        if budgets and model not in _unpriced:
            _unpriced.add(model)
            log.warning("no price for model %s: its answers are not counted against the budgets", model)
        return None
    read = usage.get("cache_read_input_tokens", 0)
    written = usage.get("cache_creation_input_tokens", 0)
    fresh = usage.get("input_tokens", 0)
    if "over" in price and fresh + read + written > price["over_tokens"]:
        price = price["over"]
    return (fresh * price["in"] + written * price["write_1h" if cache_1h else "write"]
            + read * price["read"] + usage.get("output_tokens", 0) * price["out"]) / 1e6


def _day(now: datetime) -> str:
    return now.astimezone(UTC).date().isoformat()


_store_failed = False


def _store_error(exc: sqlite3.Error) -> None:
    """Counting spend must never fail an answer; say so once in the log."""
    global _store_failed
    if not _store_failed:
        _store_failed = True
        log.error("model spend could not be read or saved, so the budgets are not enforced: %s", exc)


def add(usd: float, now: datetime | None = None) -> None:
    if usd > 0:
        try:
            sessions.add_spend(_day(now or datetime.now(UTC)), usd)
        except sqlite3.Error as exc:
            _store_error(exc)


@dataclass
class Spent:
    today: float
    month: float


def spent(now: datetime | None = None) -> Spent:
    try:
        today, month = sessions.spend(_day(now or datetime.now(UTC)))
    except sqlite3.Error as exc:
        _store_error(exc)
        return Spent(0.0, 0.0)
    return Spent(float(today), float(month))


def over_budget(now: datetime | None = None) -> tuple[str, datetime] | None:
    """(why, until when) when a budget is used up, else None."""
    daily, monthly = settings.model_budget_daily_usd, settings.model_budget_monthly_usd
    if daily <= 0 and monthly <= 0:
        return None
    now = (now or datetime.now(UTC)).astimezone(UTC)
    s = spent(now)
    if monthly > 0 and s.month >= monthly:
        first = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        nxt = (first + timedelta(days=32)).replace(day=1)
        return f"monthly budget of ${monthly:g} reached (${s.month:.4f} spent)", nxt
    if daily > 0 and s.today >= daily:
        midnight = now.replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=1)
        return f"daily budget of ${daily:g} reached (${s.today:.4f} spent)", midnight
    return None
