"""The agent's tools, run in-process. The scene catalogue (STAC over HTTP) is
the only source: the live Bhoonidhi portal is never called here. Quicklook
images still come from the portal, through the /quicklook proxy in main.py,
because the catalogue links to them rather than copying them.

- Places: the same Nominatim search as the palette's @ (geocode.py).
- Scenes: search_catalog, over a box or an exact circle, up to 1,000 per
  search, newest first.
- Hand-off: the `bhd` commands a user runs on their own machine, under their
  own login, to download. The API never downloads.

Every tool returns plain JSON. The catalogue is updated weekly, so the newest
scenes may be up to a week old.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import math
import re
import shlex
from collections import Counter
from collections.abc import Awaitable, Callable
from datetime import date, datetime
from typing import Any
from zoneinfo import ZoneInfo

import httpx
from bhoonidhi_downloader.sdk import Availability

from . import archive, geocode, names
from .config import settings

# How the handed-off commands start bhd: through uvx, pinned to the release
# they are written for, so they run anywhere uv is installed, with no bhd
# install. The login and saved searches live in ~/.bhoonidhi, so separate
# uvx runs share them. 0.5.6 is the first release with `query create --slug`.
BHD = ["uvx", "bhoonidhi-downloader@0.5.6"]

# In a terminal, `query create` and `query download` open a scrolling table
# that waits for q; --plain prints it and exits, so the next command runs.
PLAIN = "--plain"


def throwaway_slug(label: str, key: str) -> str:
    """A name for a search the handed-off commands save, download from and
    then delete: the readable label plus a short hash of `key`, so different
    searches never share it and the same one always gets it. Lower-case
    letters, digits and hyphens, as `bhd query create --slug` requires."""
    digest = hashlib.sha1(key.encode()).hexdigest()[:6]
    return re.sub(r"[^a-z0-9]+", "-", f"{label}-{digest}".lower()).strip("-")

# Scenes a search asks the catalogue for. When more match, the count reads
# "N+" and only the newest N are drawn: 1,000, less any scene the catalogue
# returned twice.
MAX_SCENES = 1000

# Items read per collection when learning which product levels it holds.
# 200 finds 106 of the catalogue's 108 SELECTION values in about 1.5 s over
# every collection; 50 takes 0.5 s but finds only 101.
_LEVEL_SAMPLE = 200

# Date windows one search may carry. A question about one month of each year
# needs one per year, and 120 windows cost about the same as one, so this
# only guards against a runaway model.
_MAX_WINDOWS = 200

_MONTHS = ("January", "February", "March", "April", "May", "June",
           "July", "August", "September", "October", "November", "December")

# Things people routinely ask for that no scene in this catalogue records.
# Named in the system prompt rather than returned with every search: a list
# attached to every result gets recited in every answer, which is noise and
# crowds out what the user asked. The agent needs to know these only when the
# user's words reach for one of them.
NOT_RECORDED = (
    "cloud cover or cloud percentage (offer the quicklook images to judge by eye), "
    "pass direction (ascending or descending), sun elevation and azimuth, "
    "look angle and off-nadir angle"
)

# The portal dates acquisitions in Indian time.
IST = ZoneInfo("Asia/Kolkata")

# Item fields the app and the model use; the rest of each item (dozens of raw
# portal fields) stays on the server.
_FIELDS = {
    "include": [
        "id", "collection", "geometry", "assets.thumbnail",
        "properties.datetime", "properties.DOP", "properties.SATELLITE", "properties.SENSOR",
        "properties.SELECTION", "properties.gsd",
        "properties.bhoonidhi:availability", "properties.bhoonidhi:downloadable",
    ],
    "exclude": ["links"],
}


def today() -> date:
    return datetime.now(IST).date()


def stac_enabled() -> bool:
    return bool(settings.stac_api_url)


def stac_public_url() -> str | None:
    """The STAC API's address for browsers: STAC_PUBLIC_URL, else
    STAC_API_URL, without a trailing slash; None when neither is set."""
    url = (settings.stac_public_url or settings.stac_api_url).rstrip("/")
    return url or None


async def _stac(method: str, path: str, json: dict | None = None) -> dict[str, Any]:
    async with httpx.AsyncClient(base_url=settings.stac_api_url, timeout=60) as client:
        r = await client.request(method, path, json=json)
        r.raise_for_status()
        return r.json()


# --- the catalogue's collections, with the portal's names -------------------

_catalogue_cache: list[names.Collection] | None = None


def _satellite_of(selection: str, instrument: str) -> str | None:
    """"ResourceSat-2A_LISS4(MX23)_L2" -> "ResourceSat-2A". The instrument
    anchors the split, since product names can contain underscores."""
    at = selection.find(f"_{instrument}")
    return selection[:at] if at > 0 else None


async def catalogue() -> list[names.Collection]:
    """Every collection with the satellite and sensor names `bhd` uses, and the
    product levels it holds. The collection records carry only lower-case
    platform ids and an empty bhoonidhi:products summary, so both are read from
    the collection's own items. Loaded once per process (about 1.5s)."""
    global _catalogue_cache
    if _catalogue_cache is not None:
        return _catalogue_cache
    # The API pages collections (10 by default); ask for all of them.
    raw = (await _stac("GET", "/collections?limit=1000")).get("collections", [])

    async def selections(cid: str) -> list[str]:
        """Every SELECTION value in a collection. One collection can hold
        several product levels (Sentinel-2 MSI holds Level-1C and Level-2A),
        so a sample is taken rather than a single item."""
        try:
            data = await _stac("POST", "/search", json={
                "collections": [cid], "limit": _LEVEL_SAMPLE,
                "fields": {"include": ["properties.SELECTION"], "exclude": ["geometry", "assets", "links"]},
            })
        except httpx.HTTPError:
            return []
        seen = ((f.get("properties") or {}).get("SELECTION") for f in data.get("features") or [])
        return list(dict.fromkeys(s for s in seen if s))

    sampled = await asyncio.gather(*(selections(c["id"]) for c in raw))
    by_platform: dict[str, str] = {}
    for c, sels in zip(raw, sampled, strict=True):
        s = c.get("summaries") or {}
        sat = _satellite_of(sels[0] if sels else "", (s.get("instruments") or [""])[0])
        if sat:
            by_platform[(s.get("platform") or [""])[0]] = sat

    # The portal's own list of products, which is complete where a sample is
    # not. Falls back to the sample when the `bhd` cache is missing.
    from_archive = archive.selections()

    out = []
    for c, sels in zip(raw, sampled, strict=True):
        s = c.get("summaries") or {}
        platform = (s.get("platform") or [""])[0]
        interval = (((c.get("extent") or {}).get("temporal") or {}).get("interval") or [[None, None]])[0]
        satellite = by_platform.get(platform) or platform.upper()
        sensor = (s.get("instruments") or [""])[0]
        out.append(names.Collection(
            id=c["id"],
            platform=platform,
            # A collection with no items borrows the name its siblings use.
            satellite=satellite,
            sensor=sensor,
            gsd_m=(s.get("gsd") or [None])[0],
            start=(interval[0] or "")[:10] or None,
            end=(interval[1] or "")[:10] or None,
            products=from_archive.get(f"{satellite}_{sensor}") or tuple(sels),
        ))
    _catalogue_cache = out
    return out


async def list_collections() -> dict[str, Any]:
    """Satellites and their sensors, with the dates the catalogue covers."""
    by_sat: dict[str, dict[str, Any]] = {}
    for c in await catalogue():
        entry = by_sat.setdefault(c.satellite, {"satellite": c.satellite, "sensors": [], "from": c.start, "to": c.end})
        entry["sensors"].append(c.sensor)
        if c.start and (not entry["from"] or c.start < entry["from"]):
            entry["from"] = c.start
        if c.end and (not entry["to"] or c.end > entry["to"]):
            entry["to"] = c.end
    return {"satellites": list(by_sat.values())}


# --- places ------------------------------------------------------------------


async def resolve_location(name: str) -> dict[str, Any]:
    """The best match for a place name, from the palette's place search."""
    try:
        places = await geocode.search(name, 1)
    except httpx.HTTPError as exc:
        return {"found": False, "query": name, "reason": f"Place search failed: {exc}"}
    if not places:
        return {"found": False, "query": name, "reason": "No place of that name was found."}
    p = places[0]
    b = p["bbox"]
    return {
        "found": True,
        "name": p["detail"] or p["name"],
        "lat": p["lat"],
        "lon": p["lon"],
        "bbox": {"minx": b["west"], "miny": b["south"], "maxx": b["east"], "maxy": b["north"]},
    }


# --- scenes ------------------------------------------------------------------

_EARTH_RADIUS_KM = 6371.0088


def circle_polygon(lon: float, lat: float, radius_km: float, steps: int = 64) -> dict[str, Any]:
    """A circle on the ground as a GeoJSON polygon, for an exact-circle search."""
    d = radius_km / _EARTH_RADIUS_KM
    lat1, lon1 = math.radians(lat), math.radians(lon)
    ring = []
    for i in range(steps):
        b = 2 * math.pi * i / steps
        lat2 = math.asin(math.sin(lat1) * math.cos(d) + math.cos(lat1) * math.sin(d) * math.cos(b))
        lon2 = lon1 + math.atan2(math.sin(b) * math.sin(d) * math.cos(lat1), math.cos(d) - math.sin(lat1) * math.sin(lat2))
        ring.append([round(math.degrees(lon2), 6), round(math.degrees(lat2), 6)])
    ring.append(ring[0])
    return {"type": "Polygon", "coordinates": [ring]}


def _area(
    minx: float | None, miny: float | None, maxx: float | None, maxy: float | None,
    lat: float | None, lon: float | None, radius_km: float | None,
) -> tuple[dict[str, Any] | None, str | None]:
    """The search area as a STAC search fragment, or an error message. No
    area at all means the whole catalogue."""
    box = [minx, miny, maxx, maxy]
    has_box = any(v is not None for v in box)
    has_point = lat is not None or lon is not None
    if has_box and has_point:
        return None, "Give the area either as minx, miny, maxx, maxy or as lat, lon, radius_km, not both."
    if has_box:
        if minx is None or miny is None or maxx is None or maxy is None:
            return None, "A box needs all four of minx, miny, maxx, maxy."
        if minx >= maxx or miny >= maxy:
            return None, "The box is inverted: minx must be below maxx and miny below maxy."
        return {"bbox": [minx, miny, maxx, maxy]}, None
    if has_point:
        if lat is None or lon is None:
            return None, "A circle needs both lat and lon."
        r = 10.0 if radius_km is None else radius_km
        if not 1 <= r <= 100:
            return None, "radius_km must be between 1 and 100."
        return {"intersects": circle_polygon(lon, lat, r)}, None
    return None, None


def _availability_label(value: Any) -> str | None:
    """Catalogue items store the enum value ("direct_unavailable"); the app
    uses its label ("Archived"). Map through the SDK's enum."""
    try:
        return Availability(value).label
    except ValueError:
        return value if isinstance(value, str) else None


def _availability_value(wanted: str | None) -> tuple[str | None, str | None]:
    """A user's availability word as the catalogue's enum value, or an error.
    Accepts the label ("Ready", "On order"), the enum value itself, and the
    plain words people use for the one that matters."""
    if not wanted:
        return None, None
    key = re.sub(r"[^a-z]", "", wanted.lower())
    plain = {
        "ready": Availability.DIRECT_AVAILABLE,
        "available": Availability.DIRECT_AVAILABLE,
        "downloadable": Availability.DIRECT_AVAILABLE,
        "downloadablenow": Availability.DIRECT_AVAILABLE,
        "now": Availability.DIRECT_AVAILABLE,
    }
    if key in plain:
        return plain[key].value, None
    for member in Availability:
        if key in (re.sub(r"[^a-z]", "", member.value.lower()), re.sub(r"[^a-z]", "", member.label.lower())):
            return member.value, None
    return None, (
        f"{wanted!r} is not an availability the STAC API uses. "
        f"It has {', '.join(m.label for m in Availability)}."
    )


def _area_polygon(area: dict[str, Any]) -> dict[str, Any]:
    """The search area as a polygon, for a containment test. A circle is
    already one; a box becomes its four corners."""
    if "intersects" in area:
        return area["intersects"]
    minx, miny, maxx, maxy = area["bbox"]
    ring = [[minx, miny], [maxx, miny], [maxx, maxy], [minx, maxy], [minx, miny]]
    return {"type": "Polygon", "coordinates": [ring]}


def _levels_held(collections: list[names.Collection]) -> list[str]:
    """Every product level the chosen collections hold, once."""
    return list(dict.fromkeys(lv for c in collections for lv in names.levels(c)))


def _no_such_level(resolved: names.Resolved) -> dict[str, Any]:
    held = _levels_held(resolved.collections)
    return {
        "status": "no_such_product_level",
        "error": (
            f"These satellites do not have {', '.join(resolved.missing_products)}."
            if held else
            f"The STAC API does not record product levels for {resolved.collections[0].satellite}."
        ),
        "product_levels": held,
        "hint": "Tell the user which levels exist and ask which they want, or search without a level.",
    }


def _item_to_scene(item: dict[str, Any]) -> dict[str, Any]:
    p = item.get("properties") or {}
    thumb = (item.get("assets") or {}).get("thumbnail") or {}
    geom = item.get("geometry")
    return {
        "id": item.get("id"),
        "collection": item.get("collection"),
        "satellite": p.get("SATELLITE"),
        "sensor": p.get("SENSOR"),
        "selection": p.get("SELECTION"),
        "date_of_pass": p.get("DOP") or (p.get("datetime") or "")[:10],
        "availability": _availability_label(p.get("bhoonidhi:availability")),
        "downloadable": p.get("bhoonidhi:downloadable"),
        "gsd_m": p.get("gsd"),
        "footprint": geom if (geom or {}).get("type") == "Polygon" else None,
        # Portal-hosted; fetched through the /quicklook proxy.
        "quicklook_url": thumb.get("href"),
    }


def _unknown_names(resolved: names.Resolved, cat: list[names.Collection]) -> dict[str, Any]:
    return {
        "status": "unknown_name",
        "error": f"Not a satellite or sensor in the STAC API: {', '.join(resolved.unknown)}.",
        "satellites": names.satellites(cat),
        "hint": "Ask the user which of these they meant, or call list_collections for sensors.",
    }


def _windows(
    start_date: str | None, end_date: str | None, date_windows: list[dict[str, str]] | None,
) -> tuple[list[tuple[date, date]], str | None]:
    """The date windows a search covers, as (start, end) pairs.

    One window is the ordinary case. Several express a question one range
    cannot: "May of each year for ten years" is eleven Mays, not one span from
    the first May to the last, which would also return every June through
    April in between. The catalogue tests them in a single query, and 120
    windows cost the same as one.

    Giving date_windows makes start_date and end_date redundant, so they are
    optional; a model that sends only the windows must not be answered with a
    missing-argument error it has to guess its way out of.
    """
    raw = date_windows or ([{"start_date": start_date, "end_date": end_date}]
                           if start_date or end_date else [])
    if not raw:
        return [], "Give a date range (start_date and end_date) or date_windows."
    out: list[tuple[date, date]] = []
    for w in raw:
        s, e = w.get("start_date"), w.get("end_date")
        if not s or not e:
            return [], "Every date window needs a start_date and an end_date."
        try:
            pair = (date.fromisoformat(s), date.fromisoformat(e))
        except (TypeError, ValueError) as exc:
            return [], f"Use YYYY-MM-DD dates ({exc})."
        if pair[1] < pair[0]:
            return [], f"end_date {e} is before start_date {s}."
        out.append(pair)
    if len(out) > _MAX_WINDOWS:
        return [], f"At most {_MAX_WINDOWS} date windows; {len(out)} were given."
    return sorted(out), None


def _window_filter(windows: list[tuple[date, date]]) -> dict[str, Any] | None:
    """Several windows as one CQL2 clause. A single window needs none: the
    search's own datetime range already says it."""
    if len(windows) < 2:
        return None
    return {"op": "or", "args": [
        {"op": "t_intersects", "args": [
            {"property": "datetime"},
            {"interval": [f"{s.isoformat()}T00:00:00Z", f"{e.isoformat()}T23:59:59Z"]},
        ]}
        for s, e in windows
    ]}


def _windows_said(windows: list[tuple[date, date]]) -> str:
    """The windows as the answer should state them: "May 2016, May 2017, …"
    collapses to "May of 2016 to 2026" only when every window is the same
    month, which is the case worth naming."""
    if len(windows) == 1:
        return f"{windows[0][0].isoformat()} to {windows[0][1].isoformat()}"
    firsts = {(s.month, e.month) for s, e in windows}
    if len(firsts) == 1:
        (m1, m2) = next(iter(firsts))
        span = _MONTHS[m1 - 1] if m1 == m2 else f"{_MONTHS[m1 - 1]} to {_MONTHS[m2 - 1]}"
        return f"{span} of {windows[0][0].year} to {windows[-1][1].year}, {len(windows)} windows"
    return ", ".join(f"{s.isoformat()} to {e.isoformat()}" for s, e in windows)


def _nothing_found(
    collections: list[names.Collection], windows: list[tuple[date, date]],
) -> dict[str, Any] | None:
    """Why a search came back empty, when the collection records say why.

    A satellite that stopped before the dates asked for, or launched after
    them, is the usual cause, and the catalogue already records each
    collection's date coverage. Without this the answer can only say "no
    scenes found", which reads as if the area were never imaged.
    """
    asked_from, asked_to = windows[0][0], max(e for _, e in windows)
    reasons = []
    for c in collections:
        name = f"{c.satellite} {c.sensor}"
        if c.end and c.end < asked_from.isoformat():
            reasons.append(f"{name} has nothing after {c.end}")
        elif c.start and c.start > asked_to.isoformat():
            reasons.append(f"{name} starts on {c.start}")
    if not reasons:
        return None
    return {
        "why_empty": reasons,
        "hint": "Say this reason in the answer; do not report an empty result on its own.",
    }


async def search_catalog(
    start_date: str | None = None,
    end_date: str | None = None,
    minx: float | None = None,
    miny: float | None = None,
    maxx: float | None = None,
    maxy: float | None = None,
    lat: float | None = None,
    lon: float | None = None,
    radius_km: float | None = None,
    satellite: str | None = None,
    sensor: str | None = None,
    max_resolution_m: float | None = None,
    product_level: str | None = None,
    availability: str | None = None,
    covers_area: bool | None = None,
    date_windows: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    windows, problem = _windows(start_date, end_date, date_windows)
    if problem:
        return {"status": "invalid_request", "error": problem}
    area, problem = _area(minx, miny, maxx, maxy, lat, lon, radius_km)
    if problem:
        return {"status": "invalid_request", "error": problem}
    wanted_availability, problem = _availability_value(availability)
    if problem:
        return {"status": "invalid_request", "error": problem}

    cat = await catalogue()
    resolved = names.resolve(satellite, sensor, cat, product_level)
    if resolved.unknown:
        return _unknown_names(resolved, cat)
    if not resolved.collections:
        return {
            "status": "no_such_combination",
            "error": f"None of the satellites named ({satellite}) carries the sensor {sensor}.",
            "sensors": sorted({c.sensor for c in names.resolve(satellite, None, cat).collections}),
        }
    if resolved.missing_products and not resolved.selections:
        return _no_such_level(resolved)

    result = await run_search(
        cat, windows, area,
        collections=resolved.collections if (satellite or sensor) else None,
        selections=resolved.selections,
        wanted_availability=wanted_availability,
        max_resolution_m=max_resolution_m,
        covers_area=bool(covers_area),
        product_words=resolved.products,
        reasons_from=resolved.collections,
    )
    if resolved.missing_products and result["status"] != "none_cover_the_area":
        result["note"] += (
            f" {', '.join(resolved.missing_products)} is not a level these satellites carry; "
            f"they have {', '.join(_levels_held(resolved.collections))}."
        )
    return result


async def run_search(
    cat: list[names.Collection],
    windows: list[tuple[date, date]],
    area: dict[str, Any] | None,
    *,
    collections: list[names.Collection] | None,
    selections: list[str] | tuple[str, ...] = (),
    whole_ids: list[str] | tuple[str, ...] = (),
    wanted_availability: str | None = None,
    max_resolution_m: float | None = None,
    covers_area: bool = False,
    product_words: list[str] | tuple[str, ...] = (),
    reasons_from: list[names.Collection] | None = None,
) -> dict[str, Any]:
    """One catalogue search, shared by the agent's search_catalog and the
    query form. `collections` None means every collection. `selections`
    keeps only those exact SELECTION values, except in the collections
    listed in `whole_ids`, which are searched whole: a query can ask for
    Sentinel-2's Level-2A and every LISS-4 product at once."""
    start, end = windows[0][0], max(e for _, e in windows)
    filtered = collections is not None

    body: dict[str, Any] = {
        **(area or {}),
        "datetime": f"{start.isoformat()}T00:00:00Z/{end.isoformat()}T23:59:59Z",
        "limit": MAX_SCENES,
        "sortby": [{"field": "properties.datetime", "direction": "desc"}],
        "fields": _FIELDS,
    }
    # With no satellite named, every collection loaded at start.
    body["collections"] = [c.id for c in (collections if collections is not None else cat)]

    # Everything the catalogue can narrow server-side, as one CQL2 filter.
    clauses: list[dict[str, Any]] = []
    if (window_clause := _window_filter(windows)) is not None:
        clauses.append(window_clause)
    if max_resolution_m is not None:
        clauses.append({"op": "<=", "args": [{"property": "gsd"}, max_resolution_m]})
    if selections:
        # Exact SELECTION values, not a `like`: "%SLC" would also match RSLC,
        # GSLC and Strip-SLC, which are different products.
        by_selection = {"op": "in", "args": [{"property": "SELECTION"}, list(selections)]}
        clauses.append(
            {"op": "or", "args": [{"op": "in", "args": [{"property": "collection"}, list(whole_ids)]}, by_selection]}
            if whole_ids else by_selection
        )
    if wanted_availability:
        clauses.append({"op": "=", "args": [{"property": "bhoonidhi:availability"}, wanted_availability]})
    want_cover = bool(covers_area) and area is not None
    if want_cover and area is not None:
        clauses.append({"op": "s_contains", "args": [{"property": "geometry"}, _area_polygon(area)]})
    if clauses:
        body["filter-lang"] = "cql2-json"
        body["filter"] = clauses[0] if len(clauses) == 1 else {"op": "and", "args": clauses}

    try:
        data = await _stac("POST", "/search", json=body)
    except httpx.HTTPError as exc:
        return {"status": "error", "error": f"STAC API search failed: {exc}"}

    # Asking for whole-area cover and getting nothing usually means no single
    # scene is that big, not that there is no imagery. Say so with the number
    # that do overlap, so the answer is never a bare empty result.
    overlapping: int | None = None
    if want_cover and not data.get("features"):
        loose = {k: v for k, v in body.items() if k != "filter"}
        rest = [c for c in clauses if c.get("op") != "s_contains"]
        if rest:
            loose["filter"] = rest[0] if len(rest) == 1 else {"op": "and", "args": rest}
        else:
            loose.pop("filter-lang", None)
        try:
            found = (await _stac("POST", "/search", json=loose)).get("features", [])
            overlapping = len({f.get("id") for f in found})
        except httpx.HTTPError:
            overlapping = None

    # The catalogue files some scenes under two products (every scene in
    # NovaSAR's "All" collection is also under a named NovaSAR product;
    # ResourceSat-1 LISS-4 MX23 repeats MONO), so one scene can come back
    # twice. Keep one copy, preferring the named product over "All".
    unique: dict[str, dict[str, Any]] = {}
    for item in data.get("features", []):
        kept = unique.get(item.get("id"))
        if kept is None or str(kept.get("collection") or "").endswith("-all"):
            unique[item.get("id")] = item
    scenes = [_item_to_scene(i) for i in unique.values()]
    # The catalogue reports no match count; a "next" link means there are more.
    more = any(link.get("rel") == "next" for link in data.get("links", []))
    by_id = {c.id: c for c in cat}
    per_sat = Counter(
        f"{by_id[s['collection']].satellite} {by_id[s['collection']].sensor}" if s["collection"] in by_id
        else str(s["collection"])
        for s in scenes
    )
    result: dict[str, Any] = {
        "status": "ok",
        "source": "catalogue",
        "searched": {
            "satellites": sorted({f"{c.satellite} {c.sensor}" for c in collections or []}) if filtered else "all",
            "dates": _windows_said(windows),
            "area": "circle" if area and "intersects" in area else "box" if area else "everywhere",
        },
        "returned": len(scenes),
        "count": f"{len(scenes):,}+" if more else len(scenes),
        "more_available": more,
        "availability_summary": dict(Counter(s["availability"] or "Unknown" for s in scenes)),
        "by_satellite": dict(per_sat.most_common()),
        "note": "The STAC API is updated weekly; scenes from the last few days may not be in it yet.",
        "scenes": scenes,
    }
    if selections:
        result["searched"]["product_level"] = list(product_words)
    if len(windows) > 1:
        # The windows themselves, so an answer can say what it covered and a
        # check can see how the question was read.
        result["searched"]["date_windows"] = [
            {"start_date": s.isoformat(), "end_date": e.isoformat()} for s, e in windows
        ]
    if wanted_availability:
        result["searched"]["availability"] = _availability_label(wanted_availability)
    if want_cover:
        result["searched"]["covers_area"] = True
    if more:
        result["note"] += f" Only the newest {len(scenes):,} are shown; narrow the dates or area to see older ones."
    else:
        result["total"] = len(scenes)
    if want_cover and not scenes:
        result["status"] = "none_cover_the_area"
        result["note"] = (
            "No single scene covers the whole area. "
            + (f"{overlapping} scenes overlap part of it. " if overlapping else "")
            + "A smaller area, or a satellite with a wider swath, may be covered by one scene; "
            "several scenes together covering the area is not something this app can do yet."
        )
        result["overlapping"] = overlapping
    if scenes:
        result["newest"] = scenes[0]["date_of_pass"]
        result["oldest"] = scenes[-1]["date_of_pass"]
    elif (why := _nothing_found(reasons_from if reasons_from is not None else collections or cat, windows)) is not None:
        result.update(why)
    return result


# --- hand-off ----------------------------------------------------------------


async def bhd_command(
    start_date: str,
    end_date: str,
    satellite: str | None = None,
    sensor: str | None = None,
    minx: float | None = None,
    miny: float | None = None,
    maxx: float | None = None,
    maxy: float | None = None,
    lat: float | None = None,
    lon: float | None = None,
    radius_km: float | None = None,
    scene_ids: list[str] | None = None,
    name: str | None = None,
) -> dict[str, Any]:
    """Build the commands a user runs locally to save this search, download,
    and delete the saved search."""
    if not satellite and not sensor:
        return {"status": "invalid_request", "error": "Name the satellite (and optionally the sensor) to download."}
    area, problem = _area(minx, miny, maxx, maxy, lat, lon, radius_km)
    if problem or not area:
        return {"status": "invalid_request", "error": problem or "bhd needs an area: a box or a circle."}
    cat = await catalogue()
    resolved = names.resolve(satellite, sensor, cat)
    if resolved.unknown:
        return _unknown_names(resolved, cat)
    if not resolved.collections:
        return {"status": "no_such_combination", "error": f"{satellite} does not carry the sensor {sensor}."}

    create = [*BHD, "query", "create", start_date, end_date]
    for value in dict.fromkeys(f"{c.satellite}:{c.sensor}" for c in resolved.collections):
        create += ["--sat", value]
    if "intersects" in area:
        create += ["--lat", str(lat), "--lon", str(lon), "--radius", str(10.0 if radius_km is None else radius_km)]
    else:
        create += ["--minx", str(minx), "--maxx", str(maxx), "--miny", str(miny), "--maxy", str(maxy)]
    if name:
        create += ["--name", name]
    slug = throwaway_slug(f"search-{start_date}", shlex.join(create))
    create += ["--slug", slug, PLAIN]
    download = [*BHD, "query", "download", slug, "--out", "./bhoonidhi", PLAIN]
    if scene_ids:
        download += ["--select", ",".join(scene_ids)]
    return {
        "steps": [
            {"what": "Log in with your own Bhoonidhi account (once)", "command": shlex.join([*BHD, "auth", "login"])},
            {"what": "Save this search", "command": shlex.join(create)},
            {"what": "Download", "command": shlex.join(download)},
            {"what": "Delete the saved search", "command": shlex.join([*BHD, "query", "rm", slug])},
        ],
        "note": (
            "Runs on your machine under your login. bhd searches the live portal, "
            "so it can also find scenes newer than the STAC API has. Only Ready scenes "
            "download straight away; Archived ones may need a request on the portal first."
        ),
    }


# --- what the model sees -----------------------------------------------------

# A full scene list is large; the model gets the counts and a few scenes (for
# ids it may pass to bhd_command), while the browser gets every scene.
_MODEL_SAMPLE = 10


def for_model(name: str, result: Any) -> str:
    """A tool result as the text the model reads."""
    if name == "search_catalog" and isinstance(result, dict) and "scenes" in result:
        slim = {k: v for k, v in result.items() if k != "scenes"}
        slim["sample_scenes"] = [
            {k: s.get(k) for k in ("id", "date_of_pass", "selection", "availability")}
            for s in result["scenes"][:_MODEL_SAMPLE]
        ]
        return json.dumps(slim, default=str)
    return json.dumps(result, default=str)


# --- registry ---------------------------------------------------------------

Tool = Callable[..., Awaitable[dict[str, Any]]]

_AREA = {
    "minx": {"type": "number", "description": "West longitude (box)"},
    "miny": {"type": "number", "description": "South latitude (box)"},
    "maxx": {"type": "number", "description": "East longitude (box)"},
    "maxy": {"type": "number", "description": "North latitude (box)"},
    "lat": {"type": "number", "description": "Centre latitude (circle)"},
    "lon": {"type": "number", "description": "Centre longitude (circle)"},
    "radius_km": {"type": "number", "description": "Circle radius in km, 1 to 100 (circle)"},
}
_DATES = {
    "start_date": {"type": "string", "description": "YYYY-MM-DD"},
    "end_date": {"type": "string", "description": "YYYY-MM-DD"},
}
_NAMES = {
    "satellite": {
        "type": "string",
        "description": "Satellite name exactly as the user wrote it, e.g. 'resourcesat-2a', "
        "'Sentinel-2', 'Landsat 8 and 9'. Omit for every satellite.",
    },
    "sensor": {
        "type": "string",
        "description": "Sensor exactly as the user wrote it, e.g. 'LISS-4', 'AWiFS', 'SAR'. Optional.",
    },
}


def _spec(name: str, description: str, properties: dict, required: list[str]) -> dict:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {"type": "object", "properties": properties, "required": required},
        },
    }


def registry() -> tuple[list[dict], dict[str, Tool]]:
    """Tool specs for the model and their implementations, by name. Without a
    catalogue (STAC_API_URL empty) only the place lookup is offered."""
    specs = [
        _spec(
            "resolve_location",
            "Turn a place name into a centre point and bounding box. Call this "
            "before searching when the user names a place.",
            {"name": {"type": "string", "description": "Place name, e.g. 'Shillong'"}},
            ["name"],
        ),
    ]
    impls: dict[str, Tool] = {"resolve_location": resolve_location}
    if not stac_enabled():
        return specs, impls
    specs += [
        _spec(
            "search_catalog",
            "Search the scene catalogue: every scene over an area and date range, "
            "newest first, up to 1,000. Give the area as a box (minx, miny, maxx, "
            "maxy) or a circle (lat, lon, radius_km). Pass satellite, sensor and "
            "product level names exactly as the user wrote them; the catalogue "
            "resolves them.",
            {
                **_DATES,
                **_AREA,
                **_NAMES,
                # Keep this name and description short: as "max_gsd_m" with a
                # sentence of explanation, it stopped gpt-oss from calling the
                # tool at all.
                "max_resolution_m": {
                    "type": "number",
                    "description": "Optional. Keep scenes at or finer than this, in metres.",
                },
                "product_level": {
                    "type": "string",
                    "description": "Optional. Product level as the user wrote it, e.g. 'Level-2A', "
                                   "'L2A', 'GRD', 'SLC', 'RSLC'. Only scenes of that level come back.",
                },
                "availability": {
                    "type": "string",
                    "description": "Optional. 'Ready' for scenes that can be downloaded now, "
                                   "'On order' for scenes that must be ordered first.",
                },
                "covers_area": {
                    "type": "boolean",
                    "description": "Optional. True when the user wants scenes covering the WHOLE "
                                   "area, not scenes that only overlap part of it.",
                },
                "date_windows": {
                    "type": "array",
                    "description": "Optional. Use INSTEAD of start_date/end_date when the user asks "
                                   "for a repeating period rather than one continuous span: 'May of "
                                   "each year for the last 10 years' is 10 windows, one per May, NOT "
                                   "2016-05-01 to 2026-05-31. Same for a season each year.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "start_date": {"type": "string", "description": "YYYY-MM-DD"},
                            "end_date": {"type": "string", "description": "YYYY-MM-DD"},
                        },
                        "required": ["start_date", "end_date"],
                    },
                },
            },
            ["start_date", "end_date"],
        ),
        _spec(
            "list_collections",
            "List every satellite in the catalogue with its sensors and the dates covered.",
            {},
            [],
        ),
        _spec(
            "bhd_command",
            "Produce the commands the user runs on their own computer to save a "
            "search and download scenes with their own Bhoonidhi login. Use this "
            "whenever the user wants to download or order; this service does not "
            "download anything itself.",
            {
                **_DATES,
                **_AREA,
                **_NAMES,
                "scene_ids": {"type": "array", "items": {"type": "string"},
                              "description": "Optional: only these scenes"},
                "name": {"type": "string", "description": "Optional name for the saved search"},
            },
            ["start_date", "end_date"],
        ),
    ]
    impls.update({"search_catalog": search_catalog, "list_collections": list_collections, "bhd_command": bhd_command})
    return specs, impls
