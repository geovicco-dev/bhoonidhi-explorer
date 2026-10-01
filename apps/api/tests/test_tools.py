"""Tool-layer tests against a fake catalogue: search shaping, circles, counts,
names, the model's summary, and the hand-off commands."""
from __future__ import annotations

import asyncio
import json
import math
import re
import shlex

import httpx
import pytest

from bhoonidhi_api import agent, tools
from bhoonidhi_api.config import settings


def _collection(cid, platform, instrument, gsd, start):
    return {
        "id": cid,
        "summaries": {"platform": [platform], "instruments": [instrument], "gsd": [gsd]},
        "extent": {"temporal": {"interval": [[f"{start}T00:00:00Z", None]]}},
    }


COLLECTIONS = {
    "collections": [
        _collection("sentinel-2b-msi", "sentinel-2b", "MSI", 10.0, "2017-03-07"),
        _collection("resourcesat-2-liss4-mx23", "resourcesat-2", "LISS4(MX23)", 5.8, "2011-04-20"),
        _collection("resourcesat-2a-liss4-mx23", "resourcesat-2a", "LISS4(MX23)", 5.8, "2016-12-07"),
        # No items yet: borrows its sibling's name.
        _collection("resourcesat-2a-awifs", "resourcesat-2a", "AWIFS", 56.0, "2016-12-07"),
        # A satellite no longer flying: offered like any other.
        _collection("sentinel-1b-sar-iw", "sentinel-1b", "SAR(IW)", 10.0, "2016-04-25"),
    ]
}
# What each collection's items carry in SELECTION. One collection can hold
# several product levels, and each family spells them its own way.
SELECTIONS = {
    "sentinel-2b-msi": ["Sentinel-2B_MSI_Level-1C", "Sentinel-2B_MSI_Level-2A"],
    "resourcesat-2-liss4-mx23": ["ResourceSat-2_LISS4(MX23)_L2"],
    "resourcesat-2a-liss4-mx23": ["ResourceSat-2A_LISS4(MX23)_L2"],
    "sentinel-1b-sar-iw": ["Sentinel-1B_SAR(IW)_GRD"],
}

ITEM = {
    "type": "Feature",
    "id": "SEN2B_MSI_x",
    "collection": "sentinel-2b-msi",
    "geometry": {"type": "Polygon", "coordinates": [[[91, 26], [92, 26], [92, 25], [91, 25], [91, 26]]]},
    "properties": {
        "SATELLITE": "SEN2B", "SENSOR": "MSI", "SELECTION": "Sentinel-2B_MSI_Level-2A",
        "DOP": "2024-01-01", "datetime": "2024-01-01T00:00:00Z", "gsd": 10.0,
        "bhoonidhi:availability": "direct_unavailable", "bhoonidhi:downloadable": True,
    },
    "assets": {"thumbnail": {"href": "https://bhoonidhi.nrsc.gov.in/q/x.jpg"}},
}


def _fake(monkeypatch, features=None, more=False):
    """A fake catalogue. Returns the search bodies it received (the level
    sampling done while loading the collections is left out)."""
    seen: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/collections":
            assert request.url.params.get("limit") == "1000"
            return httpx.Response(200, json=COLLECTIONS)
        if request.url.path == "/search":
            body = json.loads(request.content)
            # Loading the catalogue asks each collection for its SELECTION
            # values only; a real search asks for the full item fields.
            if body.get("fields", {}).get("exclude") == ["geometry", "assets", "links"]:
                sels = SELECTIONS.get(body["collections"][0], [])
                return httpx.Response(200, json={"features": [{"properties": {"SELECTION": s}} for s in sels]})
            seen.append(body)
            links = [{"rel": "next", "href": "x"}] if more else []
            return httpx.Response(200, json={"features": [ITEM] if features is None else features, "links": links})
        return httpx.Response(404)

    real = httpx.AsyncClient
    monkeypatch.setattr(settings, "stac_api_url", "http://stac.test")
    monkeypatch.setattr(tools, "_catalogue_cache", None)
    monkeypatch.setattr(tools.httpx, "AsyncClient",
                        lambda *a, **k: real(*a, **{**k, "transport": httpx.MockTransport(handler)}))
    return seen


@pytest.fixture
def fake_stac(monkeypatch):
    return _fake(monkeypatch)


@pytest.fixture
def fake_stac_empty(monkeypatch):
    """A catalogue that finds nothing, for the reasons an empty result gives.
    Sentinel-2B here ends in 2019, standing in for Sentinel-1B's 2021."""
    monkeypatch.setitem(COLLECTIONS, "collections", [
        {**c, "extent": {"temporal": {"interval": [["2017-03-07T00:00:00Z", "2019-12-31T00:00:00Z"]]}}}
        if c["id"] == "sentinel-2b-msi" else c
        for c in COLLECTIONS["collections"]
    ])
    return _fake(monkeypatch, features=[])


@pytest.fixture(autouse=True)
def no_archive_cache(monkeypatch):
    """The tests describe a catalogue of their own, so the developer's real
    `bhd` cache must not feed product levels into them."""
    monkeypatch.setattr(tools.archive, "selections", lambda *a, **k: {})


def test_only_catalogue_tools_are_offered(monkeypatch):
    monkeypatch.setattr(settings, "stac_api_url", "")
    assert [s["function"]["name"] for s in tools.registry()[0]] == ["resolve_location"]
    monkeypatch.setattr(settings, "stac_api_url", "http://stac.test")
    names = {s["function"]["name"] for s in tools.registry()[0]}
    assert names == {"resolve_location", "search_catalog", "list_collections", "bhd_command"}


def test_stac_public_url_falls_back_to_the_api_url(monkeypatch):
    monkeypatch.setattr(settings, "stac_api_url", "")
    monkeypatch.setattr(settings, "stac_public_url", "")
    assert tools.stac_public_url() is None
    # A STAC API this server reaches by its container name, with no public one set.
    monkeypatch.setattr(settings, "stac_api_url", "http://stac-api:8082/")
    assert tools.stac_public_url() == "http://stac-api:8082"
    # The public address wins for the browser; searches still use the local one.
    monkeypatch.setattr(settings, "stac_public_url", "https://stac.example.org/")
    assert tools.stac_public_url() == "https://stac.example.org"
    assert settings.stac_api_url == "http://stac-api:8082/"


def test_catalogue_reads_portal_names_from_items(fake_stac):
    cat = {c.id: c for c in asyncio.run(tools.catalogue())}
    assert cat["resourcesat-2a-liss4-mx23"].satellite == "ResourceSat-2A"
    assert cat["resourcesat-2a-awifs"].satellite == "ResourceSat-2A"
    assert cat["sentinel-2b-msi"].satellite == "Sentinel-2B"
    assert cat["resourcesat-2-liss4-mx23"].sensor == "LISS4(MX23)"


def test_a_satellite_no_longer_flying_is_offered(fake_stac):
    """Every collection the catalogue holds is offered, a mission that has
    ended included: its past scenes can still be found and ordered."""
    cat = asyncio.run(tools.catalogue())
    assert "sentinel-1b-sar-iw" in {c.id for c in cat}
    asyncio.run(tools.search_catalog("2019-01-01", "2019-01-31", 1, 1, 2, 2, satellite="Sentinel-1B"))
    assert fake_stac[0]["collections"] == ["sentinel-1b-sar-iw"]


def test_a_search_naming_no_satellite_lists_every_collection(fake_stac):
    asyncio.run(tools.search_catalog("2024-01-01", "2024-01-31", 1, 1, 2, 2))
    assert fake_stac[0]["collections"] == [
        "sentinel-2b-msi", "resourcesat-2-liss4-mx23", "resourcesat-2a-liss4-mx23", "resourcesat-2a-awifs",
        "sentinel-1b-sar-iw",
    ]


def test_the_archive_list_includes_every_satellite(fake_stac, monkeypatch):
    from bhoonidhi_api import query

    monkeypatch.setattr(query, "_with_scenes", set())
    monkeypatch.setattr(query.archive, "read", lambda *a, **k: [
        {"satellite": "Sentinel-2B", "collections": [{"Sentinel-2B_MSI_Level-2A": {"sensor": "MSI"}}]},
        {"satellite": "Sentinel-1B", "collections": [{"Sentinel-1B_SAR(IW)_GRD": {"sensor": "SAR(IW)"}}]},
        {"satellite": "NOVASAR-1", "collections": [{"Novasar-1_SAR(All)": {"sensor": "SAR(All)"}}]},
    ])
    listed = asyncio.run(query.archive_list(asyncio.run(tools.catalogue())))
    assert [s["satellite"] for s in listed] == ["Sentinel-2B", "Sentinel-1B", "NOVASAR-1"]


def test_search_shapes_items_and_filters_collections(fake_stac):
    out = asyncio.run(tools.search_catalog(
        "2024-01-01", "2024-01-31", 91.0, 25.0, 92.5, 26.5, satellite="Sentinel-2B", max_resolution_m=10,
    ))
    assert out["status"] == "ok" and out["source"] == "catalogue"
    assert out["returned"] == 1 and out["total"] == 1 and out["count"] == 1
    assert out["by_satellite"] == {"Sentinel-2B MSI": 1}
    assert out["searched"]["satellites"] == ["Sentinel-2B MSI"] and out["searched"]["area"] == "box"
    scene = out["scenes"][0]
    assert scene["id"] == "SEN2B_MSI_x"
    assert scene["availability"] == "Archived"
    assert scene["quicklook_url"] == "https://bhoonidhi.nrsc.gov.in/q/x.jpg"
    assert scene["footprint"]["type"] == "Polygon"
    body = fake_stac[0]
    assert body["collections"] == ["sentinel-2b-msi"]
    assert body["bbox"] == [91.0, 25.0, 92.5, 26.5]
    assert body["datetime"] == "2024-01-01T00:00:00Z/2024-01-31T23:59:59Z"
    assert body["limit"] == tools.MAX_SCENES == 1000
    assert body["filter"] == {"op": "<=", "args": [{"property": "gsd"}, 10]}
    assert "properties.SELECTION" in body["fields"]["include"]


def test_exact_name_does_not_widen(fake_stac):
    asyncio.run(tools.search_catalog("2024-01-01", "2024-01-31", 1, 1, 2, 2, satellite="resourcesat-2a", sensor="LISS-IV"))
    assert fake_stac[0]["collections"] == ["resourcesat-2a-liss4-mx23"]


def test_circle_is_searched_as_a_circle(fake_stac):
    out = asyncio.run(tools.search_catalog("2024-01-01", "2024-01-31", lat=26.2, lon=78.2, radius_km=5.8))
    assert out["searched"]["area"] == "circle"
    body = fake_stac[0]
    assert "bbox" not in body
    ring = body["intersects"]["coordinates"][0]
    assert ring[0] == ring[-1] and len(ring) == 65
    # Every vertex 5.8 km from the centre (haversine), to within 10 m.
    for lon, lat in ring:
        dlat, dlon = math.radians(lat - 26.2), math.radians(lon - 78.2)
        a = math.sin(dlat / 2) ** 2 + math.cos(math.radians(26.2)) * math.cos(math.radians(lat)) * math.sin(dlon / 2) ** 2
        assert abs(2 * 6371.0088 * math.asin(math.sqrt(a)) - 5.8) < 0.01


def test_more_than_the_limit_says_so(monkeypatch):
    _fake(monkeypatch, features=[{**ITEM, "id": f"SEN2B_MSI_{n}"} for n in range(3)], more=True)
    out = asyncio.run(tools.search_catalog("2024-01-01", "2024-01-31", 1, 1, 2, 2))
    # The count is what came back, marked as not all there is.
    assert out["more_available"] is True and out["count"] == "3+" and "total" not in out
    assert "newest 3 " in out["note"]


def test_a_scene_filed_under_two_products_comes_back_once(monkeypatch):
    # NovaSAR files a scene under a named product and again under "All".
    _fake(monkeypatch, features=[{**ITEM, "collection": "novasar-1-sar-all"}, ITEM])
    out = asyncio.run(tools.search_catalog("2024-01-01", "2024-01-31", 1, 1, 2, 2))
    assert out["returned"] == 1 and out["count"] == 1
    assert out["scenes"][0]["collection"] == "sentinel-2b-msi"
    assert out["by_satellite"] == {"Sentinel-2B MSI": 1}


def test_unknown_name_lists_the_real_ones(fake_stac):
    out = asyncio.run(tools.search_catalog("2024-01-01", "2024-01-31", 1, 1, 2, 2, satellite="WorldView-3"))
    assert out["status"] == "unknown_name"
    assert out["satellites"] == ["Sentinel-2B", "ResourceSat-2", "ResourceSat-2A", "Sentinel-1B"]
    assert fake_stac == []


def test_satellite_without_the_sensor(fake_stac):
    out = asyncio.run(tools.search_catalog("2024-01-01", "2024-01-31", 1, 1, 2, 2, satellite="Sentinel-2B", sensor="LISS-4"))
    assert out["status"] == "no_such_combination" and out["sensors"] == ["MSI"]


def test_the_archive_supplies_levels_a_sample_would_miss(monkeypatch):
    """A sample of the newest Sentinel-2A scenes can be all Level-1C; the
    portal's product list still offers Level-2A."""
    seen = _fake(monkeypatch)
    monkeypatch.setattr(tools.archive, "selections", lambda *a, **k: {
        "Sentinel-2B_MSI": ("Sentinel-2B_MSI_Level-1C", "Sentinel-2B_MSI_Level-2A"),
    })
    cat = {c.id: c for c in asyncio.run(tools.catalogue())}
    assert cat["sentinel-2b-msi"].products == ("Sentinel-2B_MSI_Level-1C", "Sentinel-2B_MSI_Level-2A")
    # A collection the archive does not mention keeps what its items showed.
    assert cat["resourcesat-2-liss4-mx23"].products == ("ResourceSat-2_LISS4(MX23)_L2",)
    assert seen == []


def test_product_level_filters_on_exact_selection_values(fake_stac):
    out = asyncio.run(tools.search_catalog(
        "2024-01-01", "2024-01-31", 1, 1, 2, 2, satellite="Sentinel-2B", product_level="L2A"))
    assert out["status"] == "ok"
    assert out["searched"]["product_level"] == ["L2A"]
    # Exact values, not a `like`: "%SLC" would also catch RSLC and GSLC.
    assert fake_stac[0]["filter"] == {
        "op": "in", "args": [{"property": "SELECTION"}, ["Sentinel-2B_MSI_Level-2A"]],
    }


def test_product_level_written_as_the_sensor_still_filters(fake_stac):
    asyncio.run(tools.search_catalog(
        "2024-01-01", "2024-01-31", 1, 1, 2, 2, satellite="Sentinel-2B", sensor="Level-2A"))
    assert fake_stac[0]["filter"]["args"][1] == ["Sentinel-2B_MSI_Level-2A"]


def test_each_family_spells_its_levels_its_own_way(fake_stac):
    asyncio.run(tools.search_catalog(
        "2024-01-01", "2024-01-31", 1, 1, 2, 2, satellite="ResourceSat-2", product_level="L2"))
    assert fake_stac[0]["filter"]["args"][1] == ["ResourceSat-2_LISS4(MX23)_L2"]


def test_a_level_the_satellite_does_not_have_says_what_it_has(fake_stac):
    out = asyncio.run(tools.search_catalog(
        "2024-01-01", "2024-01-31", 1, 1, 2, 2, satellite="Sentinel-2B", product_level="GRD"))
    assert out["status"] == "no_such_product_level"
    assert out["product_levels"] == ["Level-1C", "Level-2A"]
    assert fake_stac == []


def test_availability_filters_and_takes_plain_words(fake_stac):
    out = asyncio.run(tools.search_catalog(
        "2024-01-01", "2024-01-31", 1, 1, 2, 2, availability="Ready"))
    assert out["searched"]["availability"] == "Ready"
    assert fake_stac[0]["filter"] == {
        "op": "=", "args": [{"property": "bhoonidhi:availability"}, "direct_available"],
    }
    out = asyncio.run(tools.search_catalog(
        "2024-01-01", "2024-01-31", 1, 1, 2, 2, availability="nonsense"))
    assert out["status"] == "invalid_request" and "Ready" in out["error"]


def test_covers_area_asks_for_containment(fake_stac):
    out = asyncio.run(tools.search_catalog(
        "2024-01-01", "2024-01-31", 91.0, 25.0, 92.5, 26.5, covers_area=True))
    assert out["searched"]["covers_area"] is True
    f = fake_stac[0]["filter"]
    assert f["op"] == "s_contains" and f["args"][0] == {"property": "geometry"}
    ring = f["args"][1]["coordinates"][0]
    assert ring[0] == ring[-1] == [91.0, 25.0] and len(ring) == 5


def test_nothing_covers_the_area_says_how_many_overlap(monkeypatch):
    """An empty whole-area search says how many scenes overlap instead."""
    calls: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/collections":
            return httpx.Response(200, json=COLLECTIONS)
        body = json.loads(request.content)
        if body.get("fields", {}).get("exclude") == ["geometry", "assets", "links"]:
            sels = SELECTIONS.get(body["collections"][0], [])
            return httpx.Response(200, json={"features": [{"properties": {"SELECTION": s}} for s in sels]})
        calls.append(body)
        covering = any("s_contains" in json.dumps(body.get("filter", {})) for _ in [0])
        three = [{**ITEM, "id": f"SEN2B_MSI_{n}"} for n in range(3)]
        return httpx.Response(200, json={"features": [] if covering else three, "links": []})

    real = httpx.AsyncClient
    monkeypatch.setattr(settings, "stac_api_url", "http://stac.test")
    monkeypatch.setattr(tools, "_catalogue_cache", None)
    monkeypatch.setattr(tools.httpx, "AsyncClient",
                        lambda *a, **k: real(*a, **{**k, "transport": httpx.MockTransport(handler)}))

    out = asyncio.run(tools.search_catalog(
        "2024-01-01", "2024-01-31", 91.0, 25.0, 92.5, 26.5, covers_area=True))
    assert out["status"] == "none_cover_the_area"
    assert out["overlapping"] == 3
    assert "No single scene covers the whole area" in out["note"] and "3 scenes overlap" in out["note"]
    # The second call drops only the containment clause.
    assert len(calls) == 2 and "filter" not in calls[1]


def test_filters_combine_in_one_query(fake_stac):
    asyncio.run(tools.search_catalog(
        "2024-01-01", "2024-01-31", 91.0, 25.0, 92.5, 26.5, satellite="Sentinel-2B",
        product_level="Level-2A", availability="Ready", covers_area=True, max_resolution_m=10))
    f = fake_stac[0]["filter"]
    assert f["op"] == "and"
    assert [c["op"] for c in f["args"]] == ["<=", "in", "=", "s_contains"]


def test_one_date_window_needs_no_filter(fake_stac):
    """The ordinary case: the search's own datetime range says it all."""
    out = asyncio.run(tools.search_catalog("2024-01-01", "2024-01-31", 1, 1, 2, 2))
    assert out["searched"]["dates"] == "2024-01-01 to 2024-01-31"
    assert "filter" not in fake_stac[0]
    assert "date_windows" not in out["searched"]


def test_may_of_each_year_is_many_windows_not_one_span(fake_stac):
    """2016-05-01 to 2026-05-31 as one range would also return every June
    through April in between."""
    windows = [{"start_date": f"{y}-05-01", "end_date": f"{y}-05-31"} for y in range(2016, 2027)]
    out = asyncio.run(tools.search_catalog(
        "2016-05-01", "2026-05-31", 1, 1, 2, 2, date_windows=windows))
    body = fake_stac[0]
    # The wide datetime still bounds the query; the windows narrow it.
    assert body["datetime"] == "2016-05-01T00:00:00Z/2026-05-31T23:59:59Z"
    assert body["filter"]["op"] == "or" and len(body["filter"]["args"]) == 11
    first = body["filter"]["args"][0]
    assert first["op"] == "t_intersects"
    assert first["args"][1]["interval"] == ["2016-05-01T00:00:00Z", "2016-05-31T23:59:59Z"]
    # Stated so the answer can name what it covered.
    assert out["searched"]["dates"] == "May of 2016 to 2026, 11 windows"
    assert len(out["searched"]["date_windows"]) == 11


def test_a_season_reads_as_its_months(fake_stac):
    windows = [{"start_date": f"{y}-06-01", "end_date": f"{y}-09-30"} for y in (2024, 2025, 2026)]
    out = asyncio.run(tools.search_catalog(
        "2024-06-01", "2026-09-30", 1, 1, 2, 2, date_windows=windows))
    assert out["searched"]["dates"] == "June to September of 2024 to 2026, 3 windows"


def test_windows_that_are_not_one_repeating_period_are_listed(fake_stac):
    windows = [{"start_date": "2024-01-01", "end_date": "2024-01-31"},
               {"start_date": "2025-07-01", "end_date": "2025-08-15"}]
    out = asyncio.run(tools.search_catalog(
        "2024-01-01", "2025-08-15", 1, 1, 2, 2, date_windows=windows))
    assert out["searched"]["dates"] == "2024-01-01 to 2024-01-31, 2025-07-01 to 2025-08-15"


def test_windows_combine_with_the_other_filters(fake_stac):
    windows = [{"start_date": f"{y}-05-01", "end_date": f"{y}-05-31"} for y in (2025, 2026)]
    asyncio.run(tools.search_catalog(
        "2025-05-01", "2026-05-31", 1, 1, 2, 2, satellite="Sentinel-2B",
        product_level="Level-2A", availability="Ready", date_windows=windows))
    f = fake_stac[0]["filter"]
    assert f["op"] == "and"
    assert [c["op"] for c in f["args"]] == ["or", "in", "="]


@pytest.mark.parametrize("windows, message", [
    ([{"start_date": "2024-01-01"}], "needs a start_date and an end_date"),
    ([{"start_date": "not-a-date", "end_date": "2024-01-31"}], "YYYY-MM-DD"),
    ([{"start_date": "2024-02-01", "end_date": "2024-01-01"}], "is before"),
    ([{"start_date": "2024-01-01", "end_date": "2024-01-31"}] * 201, "At most 200"),
])
def test_bad_date_windows(fake_stac, windows, message):
    out = asyncio.run(tools.search_catalog(
        "2024-01-01", "2024-01-31", 1, 1, 2, 2, date_windows=windows))
    assert out["status"] == "invalid_request" and message in out["error"]
    assert fake_stac == []


def test_an_empty_result_says_why_when_the_records_know(fake_stac_empty):
    """Sentinel-1B stopped in 2021; a search in 2023 must not read as if the
    area were never imaged."""
    out = asyncio.run(tools.search_catalog(
        "2023-01-01", "2023-12-31", 1, 1, 2, 2, satellite="Sentinel-2B"))
    assert out["count"] == 0
    assert out["why_empty"] == ["Sentinel-2B MSI has nothing after 2019-12-31"]


def test_an_empty_result_with_no_known_reason_says_nothing_extra(fake_stac_empty):
    out = asyncio.run(tools.search_catalog(
        "2018-01-01", "2018-12-31", 1, 1, 2, 2, satellite="Sentinel-2B"))
    assert out["count"] == 0 and "why_empty" not in out


def test_every_search_names_what_the_catalogue_cannot_filter(fake_stac):
    """The result stays about the search; what the catalogue cannot filter is
    the agent's business, not a field on every result."""
    out = asyncio.run(tools.search_catalog("2024-01-01", "2024-01-31", 1, 1, 2, 2))
    assert "what_the_catalogue_does_not_hold" not in out


def test_the_prompt_names_what_the_catalogue_cannot_filter():
    """In the prompt, not in every search result: a list attached to every
    result gets recited in every answer, which crowds out the reply."""
    prompt = agent.system_prompt()
    assert "cloud cover" in prompt and "quicklook" in prompt
    assert "off-nadir" in prompt and "ascending or descending" in prompt


def test_date_windows_alone_are_enough(fake_stac):
    """A model that sends only date_windows gets a search, not a
    missing-argument error; the windows already say the dates."""
    out = asyncio.run(tools.search_catalog(
        minx=1, miny=1, maxx=2, maxy=2,
        date_windows=[{"start_date": "2025-05-01", "end_date": "2025-05-31"},
                      {"start_date": "2026-05-01", "end_date": "2026-05-31"}]))
    assert out["status"] == "ok"
    assert out["searched"]["dates"] == "May of 2025 to 2026, 2 windows"
    assert fake_stac[0]["datetime"] == "2025-05-01T00:00:00Z/2026-05-31T23:59:59Z"


def test_a_search_with_no_dates_at_all_is_refused(fake_stac):
    out = asyncio.run(tools.search_catalog(minx=1, miny=1, maxx=2, maxy=2))
    assert out["status"] == "invalid_request" and "date" in out["error"]
    assert fake_stac == []


@pytest.mark.parametrize("args, message", [
    ({"start_date": "2024-02-01", "end_date": "2024-01-01"}, "before"),
    ({"minx": 2, "miny": 1, "maxx": 1, "maxy": 2}, "inverted"),
    ({"minx": 1, "miny": 1, "maxx": 2}, "all four"),
    ({"minx": 1, "miny": 1, "maxx": 2, "maxy": 2, "lat": 1, "lon": 1}, "not both"),
    ({"lat": 1}, "both lat and lon"),
    ({"lat": 1, "lon": 1, "radius_km": 500}, "between 1 and 100"),
])
def test_bad_input(fake_stac, args, message):
    call = {"start_date": "2024-01-01", "end_date": "2024-01-31", **args}
    out = asyncio.run(tools.search_catalog(**call))
    assert out["status"] == "invalid_request" and message in out["error"]
    assert fake_stac == []


def test_model_gets_a_summary_not_every_scene(fake_stac):
    many = [{**ITEM, "id": f"S{i}"} for i in range(40)]
    out = {**asyncio.run(tools.search_catalog("2024-01-01", "2024-01-31", 1, 1, 2, 2)), "scenes": [
        tools._item_to_scene(i) for i in many]}
    text = json.loads(tools.for_model("search_catalog", out))
    assert "scenes" not in text and len(text["sample_scenes"]) == 10
    assert set(text["sample_scenes"][0]) == {"id", "date_of_pass", "selection", "availability"}
    assert tools.for_model("resolve_location", {"found": True}) == '{"found": true}'


def test_bhd_command_uses_portal_names(fake_stac):
    out = asyncio.run(tools.bhd_command(
        "2024-01-01", "2024-01-31", satellite="resourcesat", sensor="LISS-4",
        minx=91.0, miny=25.0, maxx=92.5, maxy=26.5, scene_ids=["A", "B"], name="Shillong Jan",
    ))
    cmds = [s["command"] for s in out["steps"]]
    assert cmds[0] == "uvx bhoonidhi-downloader@0.5.6 auth login"
    create = shlex.split(cmds[1])
    assert create[:6] == ["uvx", "bhoonidhi-downloader@0.5.6", "query", "create", "2024-01-01", "2024-01-31"]
    sats = [create[i + 1] for i, a in enumerate(create) if a == "--sat"]
    assert sats == ["ResourceSat-2:LISS4(MX23)", "ResourceSat-2A:LISS4(MX23)"]
    assert create[create.index("--minx") + 1] == "91.0"
    assert create[create.index("--name") + 1] == "Shillong Jan"
    slug = create[create.index("--slug") + 1]
    assert re.fullmatch(r"search-2024-01-01-[0-9a-f]{6}", slug)
    assert create[-1] == "--plain"
    assert shlex.split(cmds[2])[4:] == [slug, "--out", "./bhoonidhi", "--plain", "--select", "A,B"]
    assert shlex.split(cmds[3])[2:] == ["query", "rm", slug]
    assert "<slug>" not in "".join(cmds)


def test_bhd_command_circle(fake_stac):
    out = asyncio.run(tools.bhd_command("2024-01-01", "2024-01-31", satellite="Sentinel-2B", lat=26.2, lon=78.2, radius_km=5.8))
    create = shlex.split(out["steps"][1]["command"])
    assert create[create.index("--lat") + 1 : create.index("--lat") + 6] == ["26.2", "--lon", "78.2", "--radius", "5.8"]
    assert "--minx" not in create


def test_bhd_command_needs_a_name_and_an_area(fake_stac):
    assert asyncio.run(tools.bhd_command("2024-01-01", "2024-01-31", minx=1, miny=1, maxx=2, maxy=2))["status"] == "invalid_request"
    assert asyncio.run(tools.bhd_command("2024-01-01", "2024-01-31", satellite="Sentinel-2B"))["status"] == "invalid_request"


def test_one_scene_hands_off_its_day_middle_and_id(fake_stac):
    from bhoonidhi_api import query

    scene = tools._item_to_scene({**ITEM, "properties": {**ITEM["properties"], "DOP": "01-Jan-2024"}})
    out = query.scene_handoff(scene, asyncio.run(tools.catalogue()))
    lines = out["bhd"].splitlines()
    assert lines[0] == "uvx bhoonidhi-downloader@0.5.6 auth login"
    create = shlex.split(lines[1])
    assert create[:8] == ["uvx", "bhoonidhi-downloader@0.5.6", "query", "create",
                          "2024-01-01", "2024-01-01", "--sat", "Sentinel-2B:MSI:Level-2A"]
    assert create[create.index("--lat") + 1 : create.index("--lat") + 6] == ["25.5", "--lon", "91.5", "--radius", "5"]
    slug = create[create.index("--slug") + 1]
    assert re.fullmatch(r"sentinel-2b-msi-2024-01-01-[0-9a-f]{6}", slug)
    assert create[-1] == "--plain"
    assert shlex.split(lines[2])[2:] == [
        "query", "download", slug, "--out", "./bhoonidhi", "--select", "SEN2B_MSI_x", "--plain",
    ]
    assert shlex.split(lines[3])[2:] == ["query", "rm", slug]
    assert "<slug>" not in out["bhd"]
    assert out["prompt"] == (
        "Using the bhoonidhi MCP tools, save a search for Sentinel-2B MSI Level-2A on 2024-01-01 "
        "around 25.5, 91.5 (5 km), then download only scene SEN2B_MSI_x."
    )


def test_a_scene_without_a_footprint_cannot_be_handed_off(fake_stac):
    from bhoonidhi_api import query

    scene = {**tools._item_to_scene(ITEM), "footprint": None}
    assert query.scene_handoff(scene, asyncio.run(tools.catalogue()))["status"] == "invalid_request"


def test_chosen_scenes_hand_off_one_search_and_their_ids(fake_stac):
    from bhoonidhi_api import query

    a = tools._item_to_scene({**ITEM, "properties": {**ITEM["properties"], "DOP": "01-Jan-2024"}})
    b = tools._item_to_scene({
        **ITEM, "id": "SEN2B_MSI_y",
        "geometry": {"type": "Polygon", "coordinates": [[[93, 27], [94, 27], [94, 26], [93, 26], [93, 27]]]},
        "properties": {**ITEM["properties"], "DOP": "15-Mar-2024"},
    })
    out = query.scenes_handoff([a, b], asyncio.run(tools.catalogue()))
    lines = out["bhd"].splitlines()
    assert lines[0] == "uvx bhoonidhi-downloader@0.5.6 auth login"
    create = shlex.split(lines[1])
    # Their days as one range, their product once, a box around their middles.
    assert create[2:9] == ["query", "create", "2024-01-01", "2024-03-15", "--sat", "Sentinel-2B:MSI:Level-2A", "--minx"]
    assert create[8:16] == ["--minx", "91.49", "--maxx", "93.51", "--miny", "25.49", "--maxy", "26.51"]
    slug = create[create.index("--slug") + 1]
    assert re.fullmatch(r"scenes-2024-01-01-[0-9a-f]{6}", slug)
    assert shlex.split(lines[2])[2:] == [
        "query", "download", slug, "--out", "./bhoonidhi", "--select", "SEN2B_MSI_x,SEN2B_MSI_y", "--plain",
    ]
    assert shlex.split(lines[3])[2:] == ["query", "rm", slug]
    assert out["prompt"] == (
        "Using the bhoonidhi MCP tools, save a search for Sentinel-2B MSI Level-2A from 2024-01-01 to 2024-03-15 "
        "in the box minx 91.49, miny 25.49, maxx 93.51, maxy 26.51, then download only these 2 scenes: "
        "SEN2B_MSI_x, SEN2B_MSI_y."
    )


def test_chosen_scenes_are_capped(fake_stac):
    from bhoonidhi_api import query

    scene = tools._item_to_scene(ITEM)
    many = [{**scene, "id": f"s{i}"} for i in range(query.MAX_SELECT + 1)]
    assert query.scenes_handoff(many, asyncio.run(tools.catalogue()))["status"] == "invalid_request"
    assert query.scenes_handoff([], asyncio.run(tools.catalogue()))["status"] == "invalid_request"


def test_resolve_location_uses_the_palette_search(monkeypatch):
    async def search(q, limit):
        assert (q, limit) == ("Gwalior", 1)
        return [{"name": "Gwalior", "detail": "Gwalior, Madhya Pradesh, India", "lat": 26.2, "lon": 78.2,
                 "bbox": {"west": 78.0, "south": 26.0, "east": 78.4, "north": 26.4}}]

    monkeypatch.setattr(tools.geocode, "search", search)
    out = asyncio.run(tools.resolve_location("Gwalior"))
    assert out["found"] and out["name"] == "Gwalior, Madhya Pradesh, India"
    assert out["bbox"] == {"minx": 78.0, "miny": 26.0, "maxx": 78.4, "maxy": 26.4}


def test_parse_arguments_repairs_stray_quote_after_number():
    from bhoonidhi_api.agent import parse_arguments

    bad = '{"start_date":"2024-01-01","minx":91.72,"maxy":25.7359931","satellite":"Sentinel-2"}'
    assert parse_arguments(bad) == {
        "start_date": "2024-01-01", "minx": 91.72, "maxy": 25.7359931, "satellite": "Sentinel-2",
    }
    # String values ending in a digit are left alone.
    assert parse_arguments('{"end_date":"2024-01-31"}') == {"end_date": "2024-01-31"}
    assert parse_arguments('{"maxy":-1.5e3"}') == {"maxy": -1500.0}
    assert parse_arguments("") == {}
    assert parse_arguments('{"a": [1, 2') is None
