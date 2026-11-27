"""A search's whole result for the Scenes tab: its counts from the STAC API's
/aggregate, and its scenes one page at a time from /search.

The search is the STAC search body run_search sent (`result["search"]`),
which the browser hands back with each request, optionally narrowed to a
date window and to chosen rows. Only the keys that describe what to find
are forwarded, so these endpoints run no search the explorer would not.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

import httpx

from . import tools

# The keys of a STAC search body that say which scenes match.
SEARCH_KEYS = tools._SEARCH_KEYS
INTERVALS = ("year", "month", "week", "day")
PAGE_MAX = 10_000
COUNTS = [
    "total_count", "datetime_min", "datetime_max", "datetime_frequency",
    "platform_datetime_frequency", "platform_selection_datetime_frequency",
]


class BadSearch(ValueError):
    """A search the endpoints refuse: no collections, or an unknown interval."""


def search_of(body: dict[str, Any]) -> dict[str, Any]:
    """The part of a STAC search body that says which scenes match."""
    return {k: body[k] for k in SEARCH_KEYS if k in body}


def _when(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _iso(value: datetime) -> str:
    return value.strftime("%Y-%m-%dT%H:%M:%SZ")


def _row_clause(row: dict[str, Any]) -> dict[str, Any]:
    # A scene's platform is its satellite code in lower case ("R2A" is
    # "r2a"), the field the STAC API's satellite counts group by.
    sat = {"op": "=", "args": [{"property": "platform"}, str(row["satellite"]).lower()]}
    if not row.get("selections"):
        return sat
    by_product = {"op": "in", "args": [{"property": "SELECTION"}, sorted(set(row["selections"]))]}
    return {"op": "and", "args": [sat, by_product]}


def narrowed(
    search: dict[str, Any],
    start: str | None = None,
    end: str | None = None,
    rows: list[dict[str, Any]] | None = None,
) -> dict[str, Any] | None:
    """The search limited to the dates [start, end] (both inclusive) and to
    the chosen rows: each row is a satellite code, optionally with the exact
    product values under it, and a scene in any of them matches. None when
    the dates fall outside the search's own, so nothing can match."""
    body = search_of(search)
    if not body.get("collections"):
        # An empty list would make the STAC API search every collection.
        raise BadSearch("The search names no collections.")
    if start or end:
        first, last = (body.get("datetime") or "../..").split("/")
        lo = max((_when(x) for x in (first, start) if x and x != ".."), default=None)
        hi = min((_when(x) for x in (last, end) if x and x != ".."), default=None)
        if lo and hi and lo > hi:
            return None
        body["datetime"] = f"{_iso(lo) if lo else '..'}/{_iso(hi) if hi else '..'}"
    clauses = [body["filter"]] if body.get("filter") else []
    if rows:
        chosen = [_row_clause(r) for r in rows]
        clauses.append(chosen[0] if len(chosen) == 1 else {"op": "or", "args": chosen})
    if clauses:
        body["filter-lang"] = "cql2-json"
        body["filter"] = clauses[0] if len(clauses) == 1 else {"op": "and", "args": clauses}
    return body


def _buckets(agg: dict[str, Any]) -> list[list[Any]]:
    return [[b["key"], b["frequency"]] for b in agg.get("buckets") or []]


async def counts(search: dict[str, Any], interval: str = "month", **narrow: Any) -> dict[str, Any]:
    """How many scenes the search finds: in all, the oldest and newest date,
    per period, and per satellite and per product of each satellite, each per
    period. A scene filed under two products counts in each of them and once
    in its satellite. A search too broad for the STAC API to count in its
    time limit answers status "too_broad"."""
    if interval not in INTERVALS:
        raise BadSearch(f"interval must be one of {list(INTERVALS)}.")
    body = narrowed(search, **narrow)
    if body is None:
        return {"status": "ok", "total": 0, "oldest": None, "newest": None, "interval": interval,
                "periods": [], "satellites": {}}
    try:
        data = await tools._stac("POST", "/aggregate", timeout=75, json={
            **body, "aggregations": COUNTS, "datetime_frequency_interval": interval})
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code == 400:
            return {"status": "too_broad", "message": tools.TOO_BIG_TO_COUNT}
        return {"status": "error", "error": f"STAC API count failed: {exc}"}
    except httpx.HTTPError as exc:
        return {"status": "error", "error": f"STAC API count failed: {exc}"}
    got = {a["name"]: a for a in data.get("aggregations") or []}
    satellites = {
        b["key"].upper(): {"total": b["frequency"], "periods": _buckets(b), "products": {}}
        for b in (got.get("platform_datetime_frequency") or {}).get("buckets") or []
    }
    for b in (got.get("platform_selection_datetime_frequency") or {}).get("buckets") or []:
        sat = satellites.setdefault(b["key"].upper(), {"total": b["frequency"], "periods": [], "products": {}})
        sat["products"] = {
            p["key"]: {"total": p["frequency"], "periods": _buckets(p)} for p in b.get("buckets") or []
        }
    return {
        "status": "ok",
        "total": (got.get("total_count") or {}).get("value", 0),
        "oldest": (got.get("datetime_min") or {}).get("value"),
        "newest": (got.get("datetime_max") or {}).get("value"),
        "interval": interval,
        "periods": _buckets(got.get("datetime_frequency") or {}),
        "satellites": satellites,
    }


def _next_token(data: dict[str, Any]) -> str | None:
    for link in data.get("links") or []:
        if link.get("rel") != "next":
            continue
        token = (link.get("body") or {}).get("token")
        if token:
            return str(token)
        href = link.get("href") or ""
        if "token=" in href:
            return href.split("token=", 1)[1].split("&", 1)[0]
    return None


async def page(
    search: dict[str, Any],
    limit: int = 100,
    token: str | None = None,
    ids: list[str] | None = None,
    **narrow: Any,
) -> dict[str, Any]:
    """One page of the search's scenes, newest first, and the token of the
    next page (None on the last). `ids` keeps only those scenes. A scene
    filed under two products can come back on two pages; the browser keeps
    the first copy it gets."""
    body = narrowed(search, **narrow)
    if body is None:
        return {"status": "ok", "scenes": [], "next": None}
    request: dict[str, Any] = {
        **body,
        "limit": max(1, min(int(limit), PAGE_MAX)),
        "sortby": [{"field": "properties.datetime", "direction": "desc"}],
        "fields": tools._FIELDS,
    }
    if ids:
        request["ids"] = list(ids)
    if token:
        request["token"] = token
    try:
        data = await tools._stac("POST", "/search", json=request)
    except httpx.HTTPError as exc:
        return {"status": "error", "error": f"STAC API search failed: {exc}"}
    return {
        "status": "ok",
        "scenes": [tools._item_to_scene(i) for i in tools.unique_items(data.get("features") or [])],
        "next": _next_token(data),
    }
