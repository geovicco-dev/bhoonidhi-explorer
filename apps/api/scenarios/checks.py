"""What a scenario checks: the search the agent ran, and the claims its answer
makes about the scenes that came back.

A check reads one finished run and returns None when it passes, or a sentence
saying what is wrong. Numbers the checks compare against are read from the
scenes the search returned, or from the catalogue at run time, so they stay
right as the weekly ingest adds scenes.
"""
from __future__ import annotations

import itertools
import json
import re
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from bhoonidhi_api import names
from bhoonidhi_api.config import settings

# The collection list, loaded once by the runner before any check runs, so a
# check can tell which satellites a search actually covered.
CATALOGUE: list[names.Collection] = []

MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]


@dataclass
class Search:
    args: dict[str, Any]
    result: dict[str, Any]

    @property
    def scenes(self) -> list[dict[str, Any]]:
        return self.result.get("scenes") or []


@dataclass
class TurnRun:
    prompt: str
    events: list[dict[str, Any]] = field(default_factory=list)
    seconds: float = 0.0

    @property
    def answer(self) -> str:
        return next((e["text"] for e in self.events if e["type"] == "answer"), "")

    @property
    def error(self) -> str:
        return next((e["message"] for e in self.events if e["type"] == "error"), "")

    @property
    def calls(self) -> list[str]:
        return [e["name"] for e in self.events if e["type"] == "tool_call"]

    @property
    def searches(self) -> list[Search]:
        out = []
        pending: dict[str, Any] | None = None
        for e in self.events:
            if e["type"] == "tool_call" and e["name"] == "search_catalog":
                pending = e["arguments"]
            elif e["type"] == "tool_result" and e["name"] == "search_catalog" and pending is not None:
                out.append(Search(pending, e["result"] if isinstance(e["result"], dict) else {}))
                pending = None
        return out


@dataclass
class Run:
    """Every turn of one scenario, in order."""
    turns: list[TurnRun] = field(default_factory=list)

    @property
    def last(self) -> TurnRun:
        return self.turns[-1]

    @property
    def searches(self) -> list[Search]:
        return self.last.searches

    @property
    def scenes(self) -> list[dict[str, Any]]:
        return [s for search in self.searches for s in search.scenes]

    @property
    def seconds(self) -> float:
        return sum(t.seconds for t in self.turns)


Check = Callable[[Run], str | None]


# --- reading a scene ---------------------------------------------------------


def scene_date(scene: dict[str, Any]) -> tuple[int, int] | None:
    """(year, month) from a scene's date of pass, which the portal writes as
    "07-MAY-2016" and the catalogue as "2016-05-07"."""
    text = (scene.get("date_of_pass") or "").strip()
    iso = re.fullmatch(r"(\d{4})-(\d{2})-\d{2}", text)
    if iso:
        return int(iso.group(1)), int(iso.group(2))
    portal = re.fullmatch(r"\d{1,2}-([A-Za-z]{3})[A-Za-z]*-(\d{4})", text)
    if portal and portal.group(1).lower() in MONTHS:
        return int(portal.group(2)), MONTHS.index(portal.group(1).lower()) + 1
    return None


def scene_level(scene: dict[str, Any]) -> str:
    """The product level, which ends the scene's SELECTION:
    "Sentinel-1A_SAR(IW)_SLC" -> "SLC"."""
    return (scene.get("selection") or "").rsplit("_", 1)[-1]


def _catalogue_post(body: dict[str, Any]) -> dict[str, Any]:
    req = urllib.request.Request(
        settings.stac_api_url.rstrip("/") + "/search",
        data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}, method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def _no_search(run: Run) -> str | None:
    if run.last.error:
        return f"the turn failed: {run.last.error[:120]}"
    if not run.searches:
        return "no catalogue search ran"
    return None


# --- checks ------------------------------------------------------------------


def searched(*expected: str) -> Check:
    """The satellites the search covered, through the same resolver the tool
    uses. Names are the catalogue's ("ResourceSat-2A")."""
    def check(run: Run) -> str | None:
        if (why := _no_search(run)) is not None:
            return why
        got: set[str] = set()
        for s in run.searches:
            resolved = names.resolve(s.args.get("satellite"), s.args.get("sensor"), CATALOGUE)
            got |= {c.satellite for c in resolved.collections}
        missing = set(expected) - got
        if missing:
            return f"searched {sorted(got)[:6]}, missing {sorted(missing)}"
        # Everything means the search had no satellite filter at all.
        if len(got) > len(expected) + 2:
            return f"searched {len(got)} satellites, expected only {sorted(expected)}"
        return None
    return check


def months(*allowed: int) -> Check:
    """Every scene that came back falls in these months. This is what catches
    a question about May answered with a continuous ten-year range."""
    names_ = ", ".join(MONTHS[m - 1].title() for m in allowed)

    def check(run: Run) -> str | None:
        if (why := _no_search(run)) is not None:
            return why
        scenes = run.scenes
        outside = [s for s in scenes if (d := scene_date(s)) and d[1] not in allowed]
        if outside:
            return f"{len(outside)} of {len(scenes)} scenes are outside {names_}"
        return None
    return check


def years(first: int, last: int) -> Check:
    def check(run: Run) -> str | None:
        if (why := _no_search(run)) is not None:
            return why
        outside = [s for s in run.scenes if (d := scene_date(s)) and not first <= d[0] <= last]
        if outside:
            return f"{len(outside)} of {len(run.scenes)} scenes are outside {first}-{last}"
        return None
    return check


def one_per_month() -> Check:
    def check(run: Run) -> str | None:
        if (why := _no_search(run)) is not None:
            return why
        per = {}
        for s in run.scenes:
            if d := scene_date(s):
                per.setdefault(d, []).append(s)
        crowded = {k: len(v) for k, v in per.items() if len(v) > 1}
        if crowded:
            return f"{len(run.scenes)} scenes over {len(per)} months, up to {max(crowded.values())} in one month"
        return None
    return check


def product_level(*levels: str) -> Check:
    def check(run: Run) -> str | None:
        if (why := _no_search(run)) is not None:
            return why
        wrong = [s for s in run.scenes if scene_level(s) not in levels]
        if wrong:
            seen = sorted({scene_level(s) for s in run.scenes})
            return f"{len(wrong)} of {len(run.scenes)} scenes are not {'/'.join(levels)} (levels: {seen[:6]})"
        return None
    return check


def availability(*labels: str) -> Check:
    def check(run: Run) -> str | None:
        if (why := _no_search(run)) is not None:
            return why
        wrong = [s for s in run.scenes if s.get("availability") not in labels]
        if wrong:
            seen = sorted({str(s.get("availability")) for s in run.scenes})
            return f"{len(wrong)} of {len(run.scenes)} scenes are not {'/'.join(labels)} (found {seen})"
        return None
    return check


def gsd_at_most(metres: float) -> Check:
    def check(run: Run) -> str | None:
        if (why := _no_search(run)) is not None:
            return why
        coarse = [s for s in run.scenes if (s.get("gsd_m") or 0) > metres]
        if coarse:
            worst = max(s.get("gsd_m") or 0 for s in coarse)
            return f"{len(coarse)} of {len(run.scenes)} scenes are coarser than {metres} m (up to {worst} m)"
        return None
    return check


def _contains(footprint: dict[str, Any] | None, lon: float, lat: float) -> bool:
    if not footprint or footprint.get("type") != "Polygon":
        return False
    ring = footprint["coordinates"][0]
    inside = False
    for (x1, y1), (x2, y2) in itertools.pairwise(ring):
        if (y1 > lat) != (y2 > lat) and lon < x1 + (lat - y1) * (x2 - x1) / (y2 - y1):
            inside = not inside
    return inside


def covers_area(ring: list[list[float]]) -> Check:
    """Every scene covers all of the area, not just a corner of it."""
    def check(run: Run) -> str | None:
        if (why := _no_search(run)) is not None:
            return why
        partial = [s for s in run.scenes if not all(_contains(s.get("footprint"), lon, lat) for lon, lat in ring)]
        if partial:
            return f"{len(partial)} of {len(run.scenes)} scenes cover only part of the area"
        return None
    return check


def oldest_year(collection_ids: list[str], bbox: list[float]) -> Check:
    """The answer names the year of the real oldest scene, which the search's
    newest-1,000 window cannot see."""
    def check(run: Run) -> str | None:
        data = _catalogue_post({
            "bbox": bbox, "collections": collection_ids, "limit": 1,
            "sortby": [{"field": "properties.datetime", "direction": "asc"}],
            "fields": {"include": ["properties.datetime"], "exclude": ["geometry", "assets", "links"]},
        })
        feats = data.get("features") or []
        if not feats:
            return "the catalogue has no scenes there, so the scenario needs new ground"
        real = feats[0]["properties"]["datetime"][:4]
        if real in run.last.answer:
            return None
        claimed = sorted(set(re.findall(r"\b(19\d{2}|20\d{2})\b", run.last.answer)))
        return f"oldest scene is from {real}; the answer says {claimed or 'no year'}"
    return check


def answer_says(*phrases: str) -> Check:
    """The answer contains at least one of these, case-insensitively."""
    def check(run: Run) -> str | None:
        text = run.last.answer.lower()
        if any(p.lower() in text for p in phrases):
            return None
        return f"the answer says none of {list(phrases)}"
    return check


def answer_avoids(*phrases: str) -> Check:
    def check(run: Run) -> str | None:
        text = run.last.answer.lower()
        hit = [p for p in phrases if p.lower() in text]
        if hit:
            return f"the answer claims {hit}"
        return None
    return check


def asks_a_question() -> Check:
    def check(run: Run) -> str | None:
        if "?" in run.last.answer:
            return None
        return "the answer asks nothing back"
    return check


def names_newest_scene() -> Check:
    """The answer gives the newest scene's date instead of only a count."""
    def check(run: Run) -> str | None:
        if (why := _no_search(run)) is not None:
            return why
        newest = next((s.result.get("newest") for s in run.searches if s.result.get("newest")), None)
        if not newest:
            return "the search returned no scenes"
        scene = {"date_of_pass": newest}
        d = scene_date(scene)
        if d is None:
            return f"cannot read the newest date {newest!r}"
        year, month = d
        text = run.last.answer.lower()
        forms = [newest.lower(), f"{MONTHS[month - 1]}", f"{year}"]
        if all(f in text for f in forms[1:]) or forms[0] in text:
            return None
        return f"the newest scene is {newest}; the answer does not name it"
    return check


def used_tool(name: str) -> Check:
    def check(run: Run) -> str | None:
        if any(name in t.calls for t in run.turns):
            return None
        return f"{name} was never called"
    return check


def searched_twice_apart() -> Check:
    """Two searches over different ground, for a question about two places."""
    def check(run: Run) -> str | None:
        if (why := _no_search(run)) is not None:
            return why
        areas = {json.dumps({k: v for k, v in s.args.items()
                             if k in ("minx", "miny", "maxx", "maxy", "lat", "lon", "radius_km")}, sort_keys=True)
                 for s in run.searches}
        if len(areas) >= 2:
            return None
        return f"{len(run.searches)} search(es) over one area; the question names two places"
    return check


def kept(**args: Any) -> Check:
    """The last search still carries these arguments (a follow-up must keep the
    filters the user did not change)."""
    def check(run: Run) -> str | None:
        if (why := _no_search(run)) is not None:
            return why
        last = run.searches[-1].args
        wrong = {k: last.get(k) for k, v in args.items() if str(last.get(k) or "").lower() != str(v).lower()}
        if wrong:
            return f"the follow-up search dropped or changed {wrong}, expected {args}"
        return None
    return check


def sensor_is(stem: str) -> Check:
    """The sensor the search resolved to, whatever spelling the model used."""
    def check(run: Run) -> str | None:
        if (why := _no_search(run)) is not None:
            return why
        sensors = {c.sensor for s in run.searches
                   for c in names.resolve(s.args.get("satellite"), s.args.get("sensor"), CATALOGUE).collections}
        wrong = {x for x in sensors if stem.lower() not in x.lower()}
        if wrong or not sensors:
            return f"searched sensors {sorted(sensors)[:6]}, expected only {stem}"
        return None
    return check


def groups_by_satellite(at_least: int = 2) -> Check:
    """A question with no satellite named gets an answer that says which
    satellites the scenes come from, not one lump count."""
    def check(run: Run) -> str | None:
        if (why := _no_search(run)) is not None:
            return why
        found = {k for s in run.searches for k in (s.result.get("by_satellite") or {})}
        if len(found) < at_least:
            return f"only {len(found)} satellite(s) in the results, so the scenario needs busier ground"
        text = run.last.answer.lower()
        named = [k for k in found if k.split()[0].lower() in text]
        if len(named) >= at_least:
            return None
        return f"the answer names {len(named)} of {len(found)} satellites: {sorted(found)[:6]}"
    return check


def area_used(lon: float, lat: float, *, expected: bool = True) -> Check:
    """Whether the search covered the area on the map. A message naming another
    place must search that place instead."""
    def check(run: Run) -> str | None:
        if (why := _no_search(run)) is not None:
            return why
        def near(s: Search) -> bool:
            args = s.args
            lat0, lon0 = args.get("lat"), args.get("lon")
            if lat0 is not None and lon0 is not None:
                return abs(lat0 - lat) < 0.05 and abs(lon0 - lon) < 0.05
            w, s0, e, n = (args.get(k) for k in ("minx", "miny", "maxx", "maxy"))
            if w is None or s0 is None or e is None or n is None:
                return False
            return w - 0.05 <= lon <= e + 0.05 and s0 - 0.05 <= lat <= n + 0.05
        hit = any(near(s) for s in run.searches)
        if hit == expected:
            return None
        return ("the search ignored the area on the map" if expected
                else "the search used the area on the map instead of the place in the message")
    return check

