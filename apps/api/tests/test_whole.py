"""The Scenes tab's counts and pages of a result (whole.py), against a fake
STAC API: how the search is narrowed, what is forwarded, and how the
answers are read."""
from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from bhoonidhi_api import tools, whole

SEARCH = {
    "collections": ["resourcesat-2a-liss3", "novasar-1-all", "novasar-1-scansar"],
    "intersects": {"type": "Point", "coordinates": [77.2, 28.6]},
    "datetime": "2025-01-01T00:00:00Z/2025-12-31T23:59:59Z",
    "filter-lang": "cql2-json",
    "filter": {"op": "=", "args": [{"property": "bhoonidhi:availability"}, "DirectDownload"]},
}

AGGREGATE = {
    "type": "AggregationCollection",
    "aggregations": [
        {"name": "total_count", "data_type": "integer", "value": 5},
        {"name": "datetime_min", "data_type": "datetime", "value": "2025-01-03T00:00:00Z"},
        {"name": "datetime_max", "data_type": "datetime", "value": "2025-02-20T00:00:00Z"},
        {"name": "datetime_frequency", "data_type": "frequency_distribution", "buckets": [
            {"key": "2025-01-01T00:00:00Z", "data_type": "frequency_distribution", "frequency": 3},
            {"key": "2025-02-01T00:00:00Z", "data_type": "frequency_distribution", "frequency": 2},
        ]},
        {"name": "platform_datetime_frequency", "data_type": "frequency_distribution", "buckets": [
            {"key": "r2a", "data_type": "frequency_distribution", "frequency": 4, "buckets": [
                {"key": "2025-01-01T00:00:00Z", "data_type": "frequency_distribution", "frequency": 3},
                {"key": "2025-02-01T00:00:00Z", "data_type": "frequency_distribution", "frequency": 1},
            ]},
            {"key": "nov1", "data_type": "frequency_distribution", "frequency": 1, "buckets": [
                {"key": "2025-02-01T00:00:00Z", "data_type": "frequency_distribution", "frequency": 1},
            ]},
        ]},
        # The one NovaSAR scene is filed under ScanSAR and again under "All",
        # so it counts in both products and once in its satellite.
        {"name": "platform_selection_datetime_frequency", "data_type": "frequency_distribution", "buckets": [
            {"key": "r2a", "data_type": "frequency_distribution", "frequency": 4, "buckets": [
                {"key": "ResourceSat-2A_LISS3_L2", "data_type": "frequency_distribution", "frequency": 4, "buckets": [
                    {"key": "2025-01-01T00:00:00Z", "data_type": "frequency_distribution", "frequency": 3},
                    {"key": "2025-02-01T00:00:00Z", "data_type": "frequency_distribution", "frequency": 1},
                ]},
            ]},
            {"key": "nov1", "data_type": "frequency_distribution", "frequency": 1, "buckets": [
                {"key": "NovaSAR-1_SAR_ScanSAR", "data_type": "frequency_distribution", "frequency": 1, "buckets": [
                    {"key": "2025-02-01T00:00:00Z", "data_type": "frequency_distribution", "frequency": 1},
                ]},
                {"key": "NovaSAR-1_SAR(All)", "data_type": "frequency_distribution", "frequency": 1, "buckets": [
                    {"key": "2025-02-01T00:00:00Z", "data_type": "frequency_distribution", "frequency": 1},
                ]},
            ]},
        ]},
    ],
}


def _item(sid, collection, date="2025-02-20"):
    return {
        "id": sid,
        "collection": collection,
        "geometry": {"type": "Polygon", "coordinates": [[[77, 28], [78, 28], [78, 29], [77, 29], [77, 28]]]},
        "assets": {"thumbnail": {"href": f"https://portal.test/{sid}.jpg"}},
        "properties": {"datetime": f"{date}T00:00:00Z", "SATELLITE": "NOV1", "SENSOR": "SAR",
                       "SELECTION": "NovaSAR-1_SAR_ScanSAR", "bhoonidhi:availability": "DirectDownload"},
    }


@pytest.fixture
def stac(monkeypatch):
    """A fake STAC API: records each request and answers from `answers`."""
    calls: list[tuple[str, str, dict]] = []
    answers: dict[str, object] = {"/aggregate": AGGREGATE, "/search": {"features": [], "links": []}}

    async def fake(method, path, json=None, timeout=60):
        calls.append((method, path, json))
        answer = answers[path]
        if isinstance(answer, Exception):
            raise answer
        return answer

    monkeypatch.setattr(tools, "_stac", fake)
    return calls, answers


def test_counts_read_the_total_the_periods_and_each_satellite(stac):
    calls, _ = stac
    got = asyncio.run(whole.counts(SEARCH, "month"))
    assert got["status"] == "ok"
    assert got["total"] == 5
    assert (got["oldest"], got["newest"]) == ("2025-01-03T00:00:00Z", "2025-02-20T00:00:00Z")
    assert got["periods"] == [["2025-01-01T00:00:00Z", 3], ["2025-02-01T00:00:00Z", 2]]
    # Satellite rows are keyed by the portal's code, which is the platform
    # field in capitals; each holds its products, keyed by SELECTION.
    jan, feb = "2025-01-01T00:00:00Z", "2025-02-01T00:00:00Z"
    assert got["satellites"] == {
        "R2A": {"total": 4, "periods": [[jan, 3], [feb, 1]],
                "products": {"ResourceSat-2A_LISS3_L2": {"total": 4, "periods": [[jan, 3], [feb, 1]]}}},
        "NOV1": {"total": 1, "periods": [[feb, 1]],
                 "products": {"NovaSAR-1_SAR_ScanSAR": {"total": 1, "periods": [[feb, 1]]},
                              "NovaSAR-1_SAR(All)": {"total": 1, "periods": [[feb, 1]]}}},
    }
    method, path, body = calls[0]
    assert (method, path) == ("POST", "/aggregate")
    assert body["datetime_frequency_interval"] == "month"
    assert body["aggregations"] == whole.COUNTS
    assert {k: body[k] for k in whole.SEARCH_KEYS if k in body} == SEARCH


def test_only_the_search_keys_are_forwarded(stac):
    calls, _ = stac
    asyncio.run(whole.page({**SEARCH, "limit": 99999, "token": "x", "query": {"gsd": {"lt": 1}}}, limit=100))
    body = calls[0][2]
    assert "query" not in body
    assert body["limit"] == 100
    assert "token" not in body


def test_a_window_narrows_the_dates_and_keeps_the_rest(stac):
    calls, _ = stac
    asyncio.run(whole.counts(SEARCH, "day", start="2025-06-01T00:00:00Z", end="2026-03-01T23:59:59Z"))
    body = calls[0][2]
    assert body["datetime"] == "2025-06-01T00:00:00Z/2025-12-31T23:59:59Z"
    assert body["filter"] == SEARCH["filter"]
    assert body["collections"] == SEARCH["collections"]


def test_a_window_outside_the_search_asks_nothing(stac):
    calls, _ = stac
    counted = asyncio.run(whole.counts(SEARCH, start="2026-02-01T00:00:00Z", end="2026-02-28T23:59:59Z"))
    paged = asyncio.run(whole.page(SEARCH, start="2024-01-01T00:00:00Z", end="2024-12-31T23:59:59Z"))
    assert counted["total"] == 0 and counted["periods"] == [] and counted["satellites"] == {}
    assert paged["scenes"] == [] and paged["next"] is None
    assert calls == []


def test_chosen_rows_join_the_search_filter(stac):
    # A whole satellite, and two products of another: a scene in any matches.
    calls, _ = stac
    asyncio.run(whole.page(SEARCH, rows=[
        {"satellite": "R2A"},
        {"satellite": "NOV1", "selections": ["NovaSAR-1_SAR_ScanSAR", "NovaSAR-1_SAR_Strip"]},
    ]))
    body = calls[0][2]
    assert body["filter"] == {"op": "and", "args": [
        SEARCH["filter"],
        {"op": "or", "args": [
            {"op": "=", "args": [{"property": "platform"}, "r2a"]},
            {"op": "and", "args": [
                {"op": "=", "args": [{"property": "platform"}, "nov1"]},
                {"op": "in", "args": [{"property": "SELECTION"}, ["NovaSAR-1_SAR_ScanSAR", "NovaSAR-1_SAR_Strip"]]},
            ]},
        ]},
    ]}
    assert body["filter-lang"] == "cql2-json"


def test_a_search_with_no_filter_gets_one(stac):
    calls, _ = stac
    plain = {k: v for k, v in SEARCH.items() if k not in ("filter", "filter-lang")}
    asyncio.run(whole.counts(plain, rows=[{"satellite": "R2A"}]))
    body = calls[0][2]
    assert body["filter"] == {"op": "=", "args": [{"property": "platform"}, "r2a"]}
    assert body["filter-lang"] == "cql2-json"


def test_a_page_of_named_scenes(stac):
    calls, _ = stac
    asyncio.run(whole.page(SEARCH, limit=2, ids=["A", "B"]))
    assert calls[0][2]["ids"] == ["A", "B"]


def test_a_search_naming_no_collections_is_refused(stac):
    calls, _ = stac
    with pytest.raises(whole.BadSearch):
        asyncio.run(whole.counts({**SEARCH, "collections": []}))
    with pytest.raises(whole.BadSearch):
        asyncio.run(whole.page({k: v for k, v in SEARCH.items() if k != "collections"}))
    with pytest.raises(whole.BadSearch):
        asyncio.run(whole.counts(SEARCH, "hour"))
    assert calls == []


def test_a_search_too_broad_to_count_says_so(stac):
    _, answers = stac
    request = httpx.Request("POST", "http://stac.test/aggregate")
    reply = httpx.Response(400, request=request, json={
        "code": "BadRequest", "description": "This search is too broad to count within the time limit."})
    answers["/aggregate"] = httpx.HTTPStatusError("400", request=request, response=reply)
    got = asyncio.run(whole.counts(SEARCH))
    assert got == {"status": "too_broad", "message": tools.TOO_BIG_TO_COUNT}


def test_a_page_keeps_one_copy_of_a_scene_and_reads_the_next_token(stac):
    calls, answers = stac
    answers["/search"] = {
        "features": [_item("A", "novasar-1-all"), _item("A", "novasar-1-scansar"), _item("B", "novasar-1-scansar")],
        "links": [{"rel": "next", "method": "POST", "href": "http://stac.test/search",
                   "body": {"token": "next:abc"}}],
    }
    got = asyncio.run(whole.page(SEARCH, limit=3, token="next:prev"))
    assert [(s["id"], s["collection"]) for s in got["scenes"]] == [("A", "novasar-1-scansar"), ("B", "novasar-1-scansar")]
    assert got["next"] == "next:abc"
    body = calls[0][2]
    assert body["token"] == "next:prev"
    assert body["sortby"] == [{"field": "properties.datetime", "direction": "desc"}]
    assert body["fields"] == tools._FIELDS


def test_the_last_page_has_no_next_token(stac):
    _, answers = stac
    answers["/search"] = {"features": [_item("B", "novasar-1-scansar")], "links": [{"rel": "self", "href": "x"}]}
    assert asyncio.run(whole.page(SEARCH))["next"] is None


def test_a_get_style_next_link_gives_its_token():
    data = {"links": [{"rel": "next", "href": "http://stac.test/search?limit=100&token=next:xyz&x=1"}]}
    assert whole._next_token(data) == "next:xyz"


def test_the_model_never_reads_the_search():
    result = {"status": "ok", "scenes": [], "search": SEARCH, "returned": 0}
    assert "search" not in json.loads(tools.for_model("search_catalog", result))
