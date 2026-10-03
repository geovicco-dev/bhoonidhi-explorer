"""Query mode: a structured catalogue search built in a form, no model involved.

A query names products (`bhd`'s `SAT:SEN[:PROD]` selections), an area, date
windows, an availability and a resolution limit. `check` reads a query and
returns what it means plus every problem with it, each with a fix where one
exists. A query with any problem never reaches the catalogue, because the
catalogue answers most wrong filters with HTTP 200, a believable count and
no error.
"""
from __future__ import annotations

import asyncio
import json
import re
import shlex
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from itertools import pairwise
from typing import Any

import httpx

from . import archive, names, tools

# Date windows in one query; the agent's search allows the same.
MAX_WINDOWS = 200

# A download command lists the found scenes by id up to this many; beyond it
# the command downloads the whole saved search instead.
MAX_SELECT = 100

_AVAILABILITY_WORDS = {"OnOrder": "On order"}


@dataclass
class Checked:
    """A query read against the catalogue: what it searches, and its problems."""

    problems: list[dict[str, Any]] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    windows: list[tuple[date, date]] = field(default_factory=list)
    area: dict[str, Any] | None = None
    # None: every collection.
    collections: list[names.Collection] | None = None
    selections: list[str] = field(default_factory=list)
    # Collections searched whole (a satellite or sensor picked without a product).
    whole_ids: list[str] = field(default_factory=list)
    availability: str | None = None
    # What each chosen item selects, as `bhd query create --sat` takes it.
    sat_values: list[str] = field(default_factory=list)
    product_words: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.problems


def _problem(field_: str, text: str, fix: dict[str, Any] | None = None, item: int | None = None) -> dict[str, Any]:
    out: dict[str, Any] = {"field": field_, "text": text}
    if item is not None:
        out["item"] = item
    if fix:
        out["fix"] = fix
    return out


def _parse_date(value: Any) -> date | None:
    try:
        return date.fromisoformat(str(value))
    except (TypeError, ValueError):
        return None


def _last_day(year: int, month: int) -> int:
    nxt = date(year + (month == 12), month % 12 + 1, 1)
    return (nxt - date(year, month, 1)).days


def windows_of(dates: dict[str, Any]) -> tuple[list[tuple[date, date]], dict[str, Any] | None]:
    """The query's dates as windows, or the problem with them.

    `{"from": "2026-08-01", "to": "2026-08-31"}` is one window. With
    `"yearly": true` the from and to days repeat every year from the from
    year to the to year: May 2016 to May 2026 is eleven Mays, not one
    ten-year span. A yearly window may cross the new year (November to
    February)."""
    raw_from, raw_to = dates.get("from"), dates.get("to")
    start, end = _parse_date(raw_from), _parse_date(raw_to)
    if raw_from and not start:
        return [], _problem("dates", f"{raw_from} is not a date. Write it as YYYY-MM-DD.")
    if raw_to and not end:
        return [], _problem("dates", f"{raw_to} is not a date. Write it as YYYY-MM-DD.")
    if not start or not end:
        return [], _problem("dates", "Give a start date and an end date.")
    if not dates.get("yearly"):
        if end < start:
            return [], _problem("dates", "The end date is before the start date.",
                                {"label": "Swap them", "set": {"dates": {**dates, "from": raw_to, "to": raw_from}}})
        return [(start, end)], None
    crosses = (end.month, end.day) < (start.month, start.day)
    out = []
    for y in range(start.year, end.year + 1):
        ey = y + 1 if crosses else y
        if ey > end.year:
            break
        s = date(y, start.month, min(start.day, _last_day(y, start.month)))
        out.append((s, date(ey, end.month, min(end.day, _last_day(ey, end.month)))))
    if not out:
        return [], _problem("dates", "Repeating each year needs the end year after the start year for a period that crosses the new year.")
    if len(out) > MAX_WINDOWS:
        return [], _problem("dates", f"At most {MAX_WINDOWS} years; this is {len(out)}.")
    return out, None


def _area(area: dict[str, Any] | None) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    """The map's area in the shape the search takes, or the problem with it."""
    if not area:
        return None, None
    try:
        if area.get("kind") == "circle":
            got, problem = tools._area(None, None, None, None, float(area["lat"]), float(area["lon"]), float(area["radius_km"]))
        else:
            w, s, e, n = (float(area[k]) for k in ("west", "south", "east", "north"))
            got, problem = tools._area(w, s, e, n, None, None, None)
    except (KeyError, TypeError, ValueError):
        return None, _problem("area", "The area could not be read. Draw it again.")
    if problem:
        return None, _problem("area", problem)
    return got, None


def _item_collections(item: dict[str, Any], cat: list[names.Collection]) -> list[names.Collection]:
    sat, sensor = item.get("satellite"), item.get("sensor")
    return [c for c in cat if c.satellite == sat and (not sensor or c.sensor == sensor)]


def item_name(item: dict[str, Any]) -> str:
    return " ".join(x for x in (item.get("satellite"), item.get("sensor"), item.get("product")) if x)


# Resolution per satellite and sensor, from `bhd`'s product list; the
# catalogue's collection records leave it empty.
_gsd_cache: dict[str, float] | None = None


def gsd(c: names.Collection) -> float | None:
    global _gsd_cache
    if _gsd_cache is None:
        _gsd_cache = {}
        for sat in archive.read():
            for entry in sat.get("collections") or []:
                for meta in entry.values():
                    key = f"{sat.get('satellite')}_{meta.get('sensor')}"
                    try:
                        res = float(str(meta.get("resolution")).split("-")[0])
                    except (TypeError, ValueError):
                        continue
                    _gsd_cache[key] = min(res, _gsd_cache.get(key, res))
    return _gsd_cache.get(f"{c.satellite}_{c.sensor}", c.gsd_m)


def check(query: dict[str, Any], cat: list[names.Collection]) -> Checked:
    """Every problem with a query, before anything is searched."""
    out = Checked()
    items: list[dict[str, Any]] = [i for i in query.get("items") or [] if isinstance(i, dict)]
    by_item = {n: _item_collections(i, cat) for n, i in enumerate(items)}

    # What to search: each item is a satellite, a sensor on it, or one product.
    chosen: list[names.Collection] = []
    for n, item in enumerate(items):
        hits = by_item[n]
        if not hits:
            out.problems.append(_problem("items", f"{item_name(item)} is not in the STAC API.",
                                         {"label": "Remove it", "remove_item": n}, n))
            continue
        chosen.extend(hits)
        product = item.get("product")
        if product:
            selection = str(item.get("selection") or f"{item['satellite']}_{item['sensor']}_{product}")
            if not any(selection in c.products for c in hits):
                held = dict.fromkeys(lv for c in hits for lv in names.levels(c))
                out.problems.append(_problem(
                    "items", f"{item['satellite']} {item['sensor']} has no product {product}"
                    + (f"; it has {', '.join(held)}." if held else "."),
                    {"label": "Any product", "set_item": {"index": n, "product": None}}, n))
                continue
            out.selections.append(selection)
            if product not in out.product_words:
                out.product_words.append(product)
            out.sat_values.append(f"{item['satellite']}:{item['sensor']}:{product}")
        else:
            out.whole_ids.extend(c.id for c in hits)
            out.sat_values.append(f"{item['satellite']}:{item['sensor']}" if item.get("sensor") else str(item["satellite"]))
    seen: set[str] = set()
    out.collections = [c for c in chosen if not (c.id in seen or seen.add(c.id))] if items else None
    if not items:
        out.notes.append(f"No satellite chosen, so this searches all {len(cat)} sensors.")

    windows, problem = windows_of(query.get("dates") or {})
    if problem:
        out.problems.append(problem)
    out.windows = windows

    area, problem = _area(query.get("area"))
    if problem:
        out.problems.append(problem)
    out.area = area
    if not query.get("area"):
        out.notes.append("No area, so this searches everywhere and shows the newest 1,000 scenes.")
        if query.get("covers_area"):
            out.problems.append(_problem("area", "“Only scenes that cover all of it” needs an area.",
                                         {"label": "Turn it off", "set": {"covers_area": False}}))

    wanted = query.get("availability")
    if wanted:
        value, problem = tools._availability_value(str(wanted))
        if problem:
            out.problems.append(_problem("availability", problem, {"label": "Any", "set": {"availability": None}}))
        out.availability = value

    limit = query.get("max_resolution_m")
    if limit is not None:
        try:
            limit = float(limit)
        except (TypeError, ValueError):
            limit = -1.0
        if not limit > 0:
            out.problems.append(_problem("resolution", "Give the resolution limit in metres, above 0.",
                                         {"label": "No limit", "set": {"max_resolution_m": None}}))
            limit = None

    # A satellite or product the dates or the resolution limit leave empty is
    # refused by name: the user chose it, so an empty result would mislead.
    if windows:
        asked_from, asked_to = windows[0][0].isoformat(), max(e for _, e in windows).isoformat()
        for n, hits in by_item.items():
            live = [c for c in hits if (c.start or "0000") <= asked_to and (c.end or "9999") >= asked_from]
            if hits and not live:
                span = "; ".join(sorted({f"{c.start} to {c.end}" for c in hits if c.start}))
                last = max((c.end for c in hits if c.end), default=None)
                fix = None
                if last:
                    fix = {"label": f"Use {last[:4]}", "set": {"dates": {"from": f"{last[:4]}-01-01", "to": last, "yearly": False}}}
                out.problems.append(_problem(
                    "dates", f"{item_name(items[n])} has nothing in the STAC API for these dates: its scenes run {span}.",
                    fix, n))
            elif hits and len(live) < len(hits):
                gone = ", ".join(f"{c.satellite} {c.sensor}" for c in hits if c not in live)
                out.notes.append(f"{gone}: no scenes in these dates; the rest are searched.")
    if limit:
        for n, item in enumerate(items):
            hits = by_item[n]
            coarse = [c for c in hits if (gsd(c) or 0) > limit]
            if hits and len(coarse) == len(hits):
                finest = min(gsd(c) or 0 for c in coarse)
                out.problems.append(_problem(
                    "resolution",
                    f"{item_name(item)} is {finest:g} m at its finest, so “finer than {limit:g} m” leaves it out.",
                    {"label": f"Remove {item_name(item)}", "remove_item": n}, n))
            elif coarse:
                out.notes.append(
                    f"{', '.join(f'{c.satellite} {c.sensor}' for c in coarse)}: coarser than {limit:g} m, left out.")
    return out


async def run(query: dict[str, Any], cat: list[names.Collection]) -> dict[str, Any]:
    """Check a query and, when it has no problems, search the catalogue."""
    checked = check(query, cat)
    if not checked.ok:
        return {"status": "invalid_query", "problems": checked.problems, "notes": checked.notes}
    limit = query.get("max_resolution_m")
    result = await tools.run_search(
        cat, checked.windows, checked.area,
        collections=checked.collections,
        selections=checked.selections,
        whole_ids=checked.whole_ids,
        wanted_availability=checked.availability,
        max_resolution_m=float(limit) if limit is not None else None,
        covers_area=bool(query.get("covers_area")),
        product_words=checked.product_words,
    )
    result["notes"] = checked.notes
    return result


def said(query: dict[str, Any]) -> str:
    """The query as one sentence, for its turn in the conversation."""
    what = ", ".join(item_name(i) for i in query.get("items") or []) or "every satellite"
    parts = [f"Scenes from {what}"]
    area = query.get("area")
    if area:
        parts.append(f"over {area.get('name') or ('a circle on the map' if area.get('kind') == 'circle' else 'the area on the map')}")
        if query.get("covers_area"):
            parts.append("covering all of it")
    else:
        parts.append("anywhere")
    windows, _ = windows_of(query.get("dates") or {})
    if len(windows) == 1:
        parts.append(f"from {windows[0][0]} to {windows[0][1]}")
    elif windows:
        parts.append(f"in {tools._windows_said(windows)}")
    if query.get("availability"):
        value, _ = tools._availability_value(str(query["availability"]))
        label = tools._availability_label(value) or str(query["availability"])
        parts.append(f"that are {_AVAILABILITY_WORDS.get(label, label)}")
    if query.get("max_resolution_m") is not None:
        parts.append(f"finer than {float(query['max_resolution_m']):g} m")
    return " ".join(parts) + "."


def answer(result: dict[str, Any]) -> str:
    """A one-line answer written from the result's own numbers."""
    if result.get("status") == "none_cover_the_area":
        return str(result.get("note") or "No single scene covers the whole area.")
    if not result.get("scenes"):
        why = result.get("why_empty")
        return "No scenes match." + (f" {'; '.join(why)}." if why else "")
    by_sat = ", ".join(f"{k} {v}" for k, v in (result.get("by_satellite") or {}).items())
    avail = ", ".join(f"{v} {_AVAILABILITY_WORDS.get(k, k)}" for k, v in (result.get("availability_summary") or {}).items())
    more = f" Only the newest {len(result['scenes']):,} are on the map." if result.get("more_available") else ""
    return f"{result.get('count')} scenes, {result.get('oldest')} to {result.get('newest')}: {by_sat}. {avail}.{more}"


def memory(query: dict[str, Any], result: dict[str, Any]) -> list[dict[str, Any]]:
    """What the model remembers of a query turn: the search, as arguments it
    could reuse, and the answer."""
    return [{"role": "assistant", "content": (
        "The user ran this search from the query form, without me: "
        f"{json.dumps(query, default=str)}. Result: {answer(result)}"
    )}]


def from_search(args: dict[str, Any], cat: list[names.Collection]) -> dict[str, Any]:
    """An agent's search_catalog call as a query, for "Edit query" on its turn."""
    items: list[dict[str, Any]] = []
    if args.get("satellite") or args.get("sensor"):
        resolved = names.resolve(args.get("satellite"), args.get("sensor"), cat, args.get("product_level"))
        items = _items(resolved, cat)
    raw = args.get("date_windows") or [{"start_date": args.get("start_date"), "end_date": args.get("end_date")}]
    pairs = sorted((str(w.get("start_date") or ""), str(w.get("end_date") or "")) for w in raw if isinstance(w, dict))
    dates: dict[str, Any] = {"from": pairs[0][0], "to": pairs[-1][1], "yearly": False} if pairs else {}
    if len(pairs) > 1 and all(len(s) == 10 and len(e) == 10 for s, e in pairs) and all(
        int(b[0][:4]) == int(a[0][:4]) + 1 and a[0][4:] == b[0][4:] and a[1][4:] == b[1][4:]
        for a, b in pairwise(pairs)
    ):
        dates = {"from": pairs[0][0], "to": pairs[-1][1], "yearly": True}
    area: dict[str, Any] | None = None
    if args.get("lat") is not None and args.get("lon") is not None:
        area = {"kind": "circle", "lat": args["lat"], "lon": args["lon"], "radius_km": args.get("radius_km") or 10}
    elif all(args.get(k) is not None for k in ("minx", "miny", "maxx", "maxy")):
        area = {"kind": "bbox", "west": args["minx"], "south": args["miny"], "east": args["maxx"], "north": args["maxy"]}
    value, _ = tools._availability_value(args.get("availability"))
    return {
        "items": items,
        "area": area,
        "covers_area": bool(args.get("covers_area")),
        "dates": dates,
        "availability": tools._availability_label(value) if value else None,
        "max_resolution_m": args.get("max_resolution_m"),
    }


def _items(resolved: names.Resolved, cat: list[names.Collection]) -> list[dict[str, Any]]:
    """Resolved collections as the form's items: one per product when levels
    were named; else a whole satellite when every sensor of it was chosen,
    or one item per sensor."""
    items: list[dict[str, Any]] = []
    if resolved.selections:
        for sel in resolved.selections:
            c = next((c for c in resolved.collections if sel.startswith(f"{c.satellite}_{c.sensor}_")), None)
            if c:
                items.append({"satellite": c.satellite, "sensor": c.sensor, "product": names.level_of(c, sel)})
        return items
    by_sat: dict[str, list[names.Collection]] = {}
    for c in resolved.collections:
        by_sat.setdefault(c.satellite, []).append(c)
    for sat, cols in by_sat.items():
        if len(cols) == len([c for c in cat if c.satellite == sat]):
            items.append({"satellite": sat})
        else:
            items.extend({"satellite": sat, "sensor": c.sensor} for c in cols)
    return items


# --- a typed question as a query (the nudge) --------------------------------
#
# While a question waits for the model, the form opens pre-filled from it. Only
# what the question names plainly is taken: satellite, sensor and level names,
# years and months, "ready", and a resolution in metres. Places are not looked
# up (that would call the geocoder); the area is the one on the map. Anything
# not named keeps the value of the conversation's previous search.

_MONTHS = {
    m: i + 1
    for i, names_ in enumerate(
        [
            ("january", "jan"), ("february", "feb"), ("march", "mar"), ("april", "apr"),
            ("may",), ("june", "jun"), ("july", "jul"), ("august", "aug"),
            ("september", "sep", "sept"), ("october", "oct"), ("november", "nov"), ("december", "dec"),
        ]
    )
    for m in names_
}
_YEAR = r"(?:19[7-9]\d|20\d\d)"
_MONTH = "|".join(sorted(_MONTHS, key=len, reverse=True))
_MONTH_YEAR = re.compile(rf"\b({_MONTH})\.?\s+({_YEAR})\b", re.IGNORECASE)
_YEAR_ALONE = re.compile(rf"\b({_YEAR})\b")
_RESOLUTION = [
    re.compile(r"\b(?:under|below|finer than|better than|at most|up to|<=?)\s*(\d+(?:\.\d+)?)\s*m\b", re.I),
    re.compile(r"\b(\d+(?:\.\d+)?)\s*m(?:etres?|eters?)?\s+(?:or better|or finer|or less|resolution)\b", re.I),
]
_READY = re.compile(r"\b(?:ready|downloadable)\b", re.IGNORECASE)
# Level names a question plainly uses; the catalogue's rarer levels
# ("strip", "waterspread") are ordinary words too often to be read from text.
_LEVEL = re.compile(r"^(?:l\d[a-z]?|grd|slc)$")
_WORD = re.compile(r"[A-Za-z0-9][A-Za-z0-9\-()+]*")


def _names_in(text: str, cat: list[names.Collection]) -> tuple[list[str], list[str], list[str]]:
    """Satellites, sensors and levels a question names, longest phrase first:
    "Sentinel 2 L2A" gives (["Sentinel 2"], [], ["L2A"]). Only exact names
    and known aliases count; the prefix rule `names.resolve` allows ("carto")
    would turn ordinary words such as "land" into satellites."""
    platform_keys = {k for c in cat for p in [names.norm(c.platform)] for k in (p, names._family(p), names._brand(p))}
    sensor_keys = {names.norm(c.sensor) for c in cat} | {names._stem(c.sensor) for c in cat}
    known_levels = {key for _, key in names._spellings(cat)}
    words = _WORD.findall(text)
    sats: list[str] = []
    sensors: list[str] = []
    levels: list[str] = []
    i = 0
    while i < len(words):
        for size in (3, 2, 1):
            phrase = " ".join(words[i : i + size])
            if len(words[i : i + size]) < size:
                continue
            key = names.norm(phrase)
            if key in platform_keys or key in names.SATELLITE_ALIASES:
                # "Landsat 8 and 9": a bare number after "and" is another
                # satellite of the same line; names.resolve reads the pair.
                while (
                    i + size + 1 < len(words)
                    and words[i + size].lower() in ("and", "or")
                    and re.fullmatch(r"\d+[A-Za-z]?", words[i + size + 1])
                ):
                    phrase = f"{phrase} and {words[i + size + 1]}"
                    size += 2
                sats.append(phrase)
            elif (
                key in sensor_keys or key in names.SENSOR_ALIASES or key in names.SENSOR_GROUPS
            ) and len(key) > 1:
                sensors.append(phrase)
            elif names.level_key(phrase) in known_levels and _LEVEL.match(names.level_key(phrase)):
                levels.append(phrase)
            else:
                continue
            i += size
            break
        else:
            i += 1
    return sats, sensors, levels


def _dates_in(text: str, today: date) -> dict[str, Any] | None:
    """The span the question's months and years cover, ending no later than
    today: "March 2023" is that month, "2019 to 2021" all three years."""
    spans: list[tuple[date, date]] = []
    rest = text
    for m in _MONTH_YEAR.finditer(text):
        month, year = _MONTHS[m.group(1).lower()], int(m.group(2))
        spans.append((date(year, month, 1), date(year, month, _last_day(year, month))))
        rest = rest.replace(m.group(0), " ")
    for m in _YEAR_ALONE.finditer(rest):
        year = int(m.group(1))
        spans.append((date(year, 1, 1), date(year, 12, 31)))
    if not spans:
        return None
    start = min(s for s, _ in spans)
    end = min(max(e for _, e in spans), today)
    if start > end:
        return None
    return {"from": start.isoformat(), "to": end.isoformat(), "yearly": False}


def from_question(
    text: str, base: dict[str, Any], area: dict[str, Any] | None, cat: list[names.Collection]
) -> dict[str, Any]:
    """The typed question as a form query, without the model. `base` is the
    conversation's previous search (or the form's blank query); what the
    question names replaces its fields, and the map's area replaces its area."""
    out = {**base}
    if area:
        out["area"] = area
    sats, sensors, levels = _names_in(text, cat)
    if sats or sensors:
        resolved = names.resolve(", ".join(sats) or None, ", ".join(sensors) or None, cat, ", ".join(levels) or None)
        if not resolved.collections and sats and sensors:
            # "Landsat or LISS-4": no satellite carries both, so take each.
            resolved = names.resolve(", ".join(sats + sensors), None, cat, ", ".join(levels) or None)
        items = _items(resolved, cat)
        if items:
            out["items"] = items
    dates = _dates_in(text, tools.today())
    if dates:
        out["dates"] = dates
    if _READY.search(text):
        out["availability"] = tools._availability_label(tools._availability_value("ready")[0])
    for pattern in _RESOLUTION:
        m = pattern.search(text)
        if m:
            out["max_resolution_m"] = float(m.group(1))
            break
    # A family named in the question ("Sentinel-2") includes satellites with
    # no scenes in its dates (Sentinel-2C before 2025). The agent would search
    # the rest; so does the form, rather than opening on a query it refuses.
    # The same test as check()'s: no collection of the item overlaps the dates.
    windows, _ = windows_of(out.get("dates") or {})
    items = out.get("items") or []
    if windows and items:
        asked_from, asked_to = windows[0][0].isoformat(), max(e for _, e in windows).isoformat()

        def has_scenes(item: dict[str, Any]) -> bool:
            hits = _item_collections(item, cat)
            return not hits or any(
                (c.start or "0000") <= asked_to and (c.end or "9999") >= asked_from for c in hits
            )

        kept = [it for it in items if has_scenes(it)]
        if kept:
            out["items"] = kept
    return out


def bhd_steps(query: dict[str, Any], scene_ids: list[str], cat: list[names.Collection]) -> dict[str, Any]:
    """The commands that download the scenes a query found: one saved `bhd`
    search over the query's whole date span with its products, a download of
    the found scenes by id, then deleting the saved search."""
    checked = check(query, cat)
    if not checked.ok:
        return {"status": "invalid_query", "problems": checked.problems}
    if not checked.sat_values:
        return {"status": "invalid_request", "error": "Choose at least one satellite to download."}
    area = query.get("area")
    if not area:
        return {"status": "invalid_request", "error": "bhd needs an area: draw one or pick a place."}
    if not scene_ids:
        return {"status": "invalid_request", "error": "The query found no scenes to download."}
    start, end = checked.windows[0][0], max(e for _, e in checked.windows)
    create = [*tools.BHD, "query", "create", start.isoformat(), end.isoformat()]
    for value in dict.fromkeys(checked.sat_values):
        create += ["--sat", value]
    if area.get("kind") == "circle":
        create += ["--lat", str(area["lat"]), "--lon", str(area["lon"]), "--radius", str(area["radius_km"])]
    else:
        create += ["--minx", str(area["west"]), "--maxx", str(area["east"]),
                   "--miny", str(area["south"]), "--maxy", str(area["north"])]
    slug = tools.throwaway_slug(f"search-{start.isoformat()}", shlex.join(create))
    create += ["--slug", slug, tools.PLAIN]
    download = [*tools.BHD, "query", "download", slug, "--out", "./bhoonidhi", tools.PLAIN]
    pick = len(scene_ids) <= MAX_SELECT
    if pick:
        download += ["--select", ",".join(scene_ids)]
    wide = len(checked.windows) > 1 or checked.availability or query.get("max_resolution_m") is not None
    note = (
        f"--select downloads only the {len(scene_ids)} scenes this query found."
        if pick else
        f"This query found {len(scene_ids)} scenes, too many to list, so the command downloads the whole saved search"
        + (", which also holds scenes outside the query's months, availability or resolution. Narrow the query to "
           f"{MAX_SELECT} scenes or fewer to download exactly these." if wide else ".")
    )
    return {
        "steps": [
            {"what": "Log in with your own Bhoonidhi account (once)", "command": shlex.join([*tools.BHD, "auth", "login"])},
            {"what": "Save this search", "command": shlex.join(create)},
            {"what": "Download", "command": shlex.join(download)},
            {"what": "Delete the saved search", "command": shlex.join([*tools.BHD, "query", "rm", slug])},
        ],
        "note": note + " Runs on your machine under your login. Only Ready scenes download straight away; "
                       "Archived ones may need a request on the portal first.",
    }


# One scene is found again by searching its day around the middle of its
# footprint; a small circle keeps the saved search to a few scenes.
SCENE_RADIUS_KM = 5


def _day(dop: str) -> date | None:
    for fmt in ("%d-%b-%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(dop[:11], fmt).replace(tzinfo=UTC).date()
        except ValueError:
            continue
    return None


def _middle(footprint: dict[str, Any] | None) -> tuple[float, float] | None:
    """The mean of a polygon's outer corners, as (lat, lon)."""
    try:
        ring = footprint["coordinates"][0][:-1]  # type: ignore[index]
        return (round(sum(p[1] for p in ring) / len(ring), 4), round(sum(p[0] for p in ring) / len(ring), 4))
    except (KeyError, IndexError, TypeError, ZeroDivisionError):
        return None


def scene_handoff(scene: dict[str, Any], cat: list[names.Collection]) -> dict[str, Any]:
    """The `bhd` commands and the MCP prompt that download one scene: save a
    search for its day around the middle of its footprint under a name chosen
    here, download only that scene by id, then delete the search."""
    c = next((c for c in cat if c.id == scene.get("collection")), None)
    day = _day(str(scene.get("date_of_pass") or ""))
    middle = _middle(scene.get("footprint"))
    sid = scene.get("id")
    if not c or not day or not middle or not sid:
        return {"status": "invalid_request", "error": "This scene lacks the satellite, date or footprint a download needs."}
    level = names.level_of(c, str(scene.get("selection") or ""))
    sat = f"{c.satellite}:{c.sensor}" + (f":{level}" if level else "")
    lat, lon = middle
    slug = tools.throwaway_slug(f"{c.id}-{day.isoformat()}", sid)
    create = [*tools.BHD, "query", "create", day.isoformat(), day.isoformat(), "--sat", sat,
              "--lat", str(lat), "--lon", str(lon), "--radius", str(SCENE_RADIUS_KM), "--slug", slug, tools.PLAIN]
    download = [*tools.BHD, "query", "download", slug, "--out", "./bhoonidhi", "--select", sid, tools.PLAIN]
    remove = [*tools.BHD, "query", "rm", slug]
    product = f"{c.satellite} {c.sensor}" + (f" {level}" if level else "")
    return {
        "bhd": "\n".join([
            shlex.join([*tools.BHD, "auth", "login"]),
            shlex.join(create),
            shlex.join(download),
            shlex.join(remove),
        ]),
        "prompt": (
            f"Using the bhoonidhi MCP tools, save a search for {product} on {day.isoformat()} "
            f"around {lat}, {lon} ({SCENE_RADIUS_KM} km), then download only scene {sid}."
        ),
    }


# Half the side, in degrees, of the box around one chosen scene's middle, so
# a single scene or scenes sharing a middle still give a box with an area.
_BOX_PAD_DEG = 0.01


def scenes_handoff(scenes: list[dict[str, Any]], cat: list[names.Collection]) -> dict[str, Any]:
    """The `bhd` commands and the MCP prompt that download several chosen
    scenes: one saved search over their days, their products and a box around
    their middles, a download of exactly those scenes by id, then deleting the
    search. The box holds every scene's middle, so each chosen scene touches it."""
    if not scenes:
        return {"status": "invalid_request", "error": "Choose at least one scene."}
    if len(scenes) > MAX_SELECT:
        return {"status": "invalid_request", "error": f"Choose {MAX_SELECT} scenes or fewer; {len(scenes)} are chosen."}
    sats: dict[str, str] = {}
    days: list[date] = []
    middles: list[tuple[float, float]] = []
    ids: list[str] = []
    for scene in scenes:
        c = next((c for c in cat if c.id == scene.get("collection")), None)
        day = _day(str(scene.get("date_of_pass") or ""))
        middle = _middle(scene.get("footprint"))
        sid = scene.get("id")
        if not c or not day or not middle or not sid:
            return {"status": "invalid_request",
                    "error": f"Scene {sid or '(no id)'} lacks the satellite, date or footprint a download needs."}
        level = names.level_of(c, str(scene.get("selection") or ""))
        sats[f"{c.satellite}:{c.sensor}" + (f":{level}" if level else "")] = (
            f"{c.satellite} {c.sensor}" + (f" {level}" if level else ""))
        days.append(day)
        middles.append(middle)
        ids.append(str(sid))
    ids = list(dict.fromkeys(ids))
    start, end = min(days), max(days)
    box = {
        "minx": round(min(lon for _, lon in middles) - _BOX_PAD_DEG, 4),
        "miny": round(min(lat for lat, _ in middles) - _BOX_PAD_DEG, 4),
        "maxx": round(max(lon for _, lon in middles) + _BOX_PAD_DEG, 4),
        "maxy": round(max(lat for lat, _ in middles) + _BOX_PAD_DEG, 4),
    }
    create = [*tools.BHD, "query", "create", start.isoformat(), end.isoformat()]
    for value in sats:
        create += ["--sat", value]
    for key in ("minx", "maxx", "miny", "maxy"):
        create += [f"--{key}", str(box[key])]
    slug = tools.throwaway_slug(f"scenes-{start.isoformat()}", ",".join(sorted(ids)))
    create += ["--slug", slug, tools.PLAIN]
    download = [*tools.BHD, "query", "download", slug, "--out", "./bhoonidhi", "--select", ",".join(ids), tools.PLAIN]
    remove = [*tools.BHD, "query", "rm", slug]
    where = (f"from {start.isoformat()} to {end.isoformat()} in the box "
             f"minx {box['minx']}, miny {box['miny']}, maxx {box['maxx']}, maxy {box['maxy']}")
    products = list(sats.values())
    search = (f"save a search for {products[0]} {where}" if len(products) == 1
              else f"save one search for each of {', '.join(products)}, {where}")
    return {
        "bhd": "\n".join([
            shlex.join([*tools.BHD, "auth", "login"]),
            shlex.join(create),
            shlex.join(download),
            shlex.join(remove),
        ]),
        "prompt": (
            f"Using the bhoonidhi MCP tools, {search}, then download only "
            + (f"scene {ids[0]}." if len(ids) == 1 else f"these {len(ids)} scenes: {', '.join(ids)}.")
        ),
    }


# Products with at least one scene in the catalogue, found once per process.
_with_scenes: set[str] | None = None


async def _selections_with_scenes(cat: list[names.Collection]) -> set[str]:
    global _with_scenes
    if _with_scenes is not None:
        return _with_scenes
    sem = asyncio.Semaphore(16)

    async def has(c: names.Collection, selection: str) -> str | None:
        async with sem:
            body: dict[str, Any] = {"collections": [c.id], "limit": 1,
                                    "fields": {"include": ["id"], "exclude": ["geometry", "assets", "links"]}}
            if selection != f"{c.satellite}_{c.sensor}":
                body |= {"filter-lang": "cql2-json",
                         "filter": {"op": "=", "args": [{"property": "SELECTION"}, selection]}}
            try:
                data = await tools._stac("POST", "/search", json=body)
            except httpx.HTTPError:
                return selection
            return selection if data.get("features") else None

    found = await asyncio.gather(*(has(c, s) for c in cat for s in (c.products or (f"{c.satellite}_{c.sensor}",))))
    _with_scenes = {s for s in found if s}
    return _with_scenes


async def archive_list(cat: list[names.Collection]) -> list[dict[str, Any]]:
    """Every satellite `bhd` knows and its products, each with its dates, its
    resolution and whether the catalogue holds any of its scenes: the query
    form's product list and the archive browser."""
    with_scenes = await _selections_with_scenes(cat)
    by_pair = {(c.satellite, c.sensor): c for c in cat}
    out = []
    for sat in archive.read():
        products = []
        for entry in sat.get("collections") or []:
            for selection, meta in entry.items():
                sensor = str(meta.get("sensor") or "")
                c = by_pair.get((str(sat.get("satellite")), sensor))
                products.append({
                    "selection": selection,
                    "sensor": sensor,
                    "product": meta.get("product_token") or None,
                    "description": str(meta.get("product") or "").strip(),
                    "resolution_m": meta.get("resolution"),
                    "start": meta.get("start_date"),
                    "end": meta.get("end_date"),
                    "collection": c.id if c else None,
                    "catalogue_start": c.start if c else None,
                    "catalogue_end": c.end if c else None,
                    "has_scenes": selection in with_scenes,
                })
        out.append({
            "satellite": sat.get("satellite"),
            "access": sat.get("access_level"),
            "from": sat.get("availability_start"),
            "to": sat.get("availability_end"),
            "products": products,
        })
    return out
