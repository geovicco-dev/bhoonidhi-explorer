"""Every way the explorer is meant to be used, as a prompt and what a right
answer must satisfy.

Each scenario is one entry in SCENARIOS. `prompts` are the user's messages in
order (later ones are follow-ups in the same conversation, so the model sees
the earlier turns). `area` is the area of interest on the map when the message
was sent. `checks` all have to pass.

Scenarios marked `screen=True` are not about the agent: they are about what the
browser does with the results, and they are listed so one table shows the whole
plan. The runner reports them as "no check yet" until their slice adds one.

Scope of the first run (2026-09-24): the scenarios slice 2 changes, plus the
ones that work today so a change cannot break them unnoticed. The rest carry
`later=True` and are added as their slices come up.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from . import checks as c

# Ground the scenarios search. Delhi is his own case; the circle is the one he
# had drawn over Mathura.
DELHI = {"kind": "bbox", "west": 76.8388351, "south": 28.4046285, "east": 77.3453379, "north": 28.8834464}
MATHURA_CIRCLE = {"kind": "circle", "lon": 77.68075958531261, "lat": 27.49906609662736, "radius_km": 5.758110774158877}
DELHI_RING = [[76.9, 28.5], [77.3, 28.5], [77.3, 28.8], [76.9, 28.8]]

LISS3 = ["irs-1c-liss3", "irs-1d-liss3", "resourcesat-1-liss3", "resourcesat-2-liss3", "resourcesat-2a-liss3"]
PUNJAB = [73.88, 29.54, 76.94, 32.51]


@dataclass
class Scenario:
    id: str
    group: str
    prompts: list[str]
    checks: list[c.Check] = field(default_factory=list)
    area: dict[str, Any] | None = None
    # What this scenario is for, in one line, printed with a failure.
    about: str = ""
    # Not an agent scenario: the browser does the work.
    screen: bool = False
    # Waiting for a later slice; not run yet.
    later: bool = False


SCENARIOS: list[Scenario] = [
    # --- 1. what exists ------------------------------------------------------
    Scenario(
        "exists-satellite-date", "what exists",
        ["LISS-4 scenes over Delhi in 2024"],
        [c.sensor_is("LISS4"), c.years(2024, 2024)],
        about="one satellite and sensor over a place and a year",
    ),
    Scenario(
        "exists-no-satellite", "what exists",
        ["What imagery is there over the area on the map from August 2026?"],
        [c.groups_by_satellite(2), c.years(2026, 2026)],
        area=DELHI,
        about="no satellite named: the answer says which satellites the scenes come from",
    ),
    Scenario(
        "exists-latest", "what exists",
        ["What is the latest Sentinel-2 scene over the area on the map?"],
        [c.searched("Sentinel-2A", "Sentinel-2B", "Sentinel-2C"), c.names_newest_scene()],
        area=DELHI,
        about="the newest scene is named, not a count of a thousand",
    ),
    Scenario(
        "exists-how-far-back", "what exists",
        ["How far back does LISS-3 imagery go over Punjab, and roughly how many scenes a year?"],
        [c.sensor_is("LISS3"), c.oldest_year(LISS3, PUNJAB)],
        about="the real oldest scene, which the newest-1,000 window cannot see",
    ),
    Scenario(
        "exists-under-5m", "what exists",
        ["Which satellites give me imagery finer than 5 m over the area on the map, in 2026?"],
        [c.gsd_at_most(5.0), c.groups_by_satellite(2)],
        area=DELHI,
        about="a resolution limit, answered by satellite",
    ),

    # --- 2. when -------------------------------------------------------------
    Scenario(
        "when-may-ten-years", "when",
        ["LISS-4 scenes over Delhi in May, from the last 10 years"],
        [c.sensor_is("LISS4"), c.months(5), c.answer_avoids("610")],
        about="his own case: May of each year, not one continuous ten-year range",
    ),
    Scenario(
        "when-monsoon", "when",
        ["Radar scenes over the area on the map during the monsoon, for the last 3 years"],
        [c.months(6, 7, 8, 9), c.answer_says("june", "jun")],
        area=DELHI,
        about="a season word: the window is the season's months and the answer states the reading",
    ),
    Scenario(
        "when-kharif", "when",
        ["Sentinel-2 scenes over the area on the map for the kharif season of 2024 and 2025"],
        [c.searched("Sentinel-2A", "Sentinel-2B", "Sentinel-2C"), c.years(2024, 2025),
         c.months(6, 7, 8, 9, 10, 11)],
        area=DELHI,
        about="a cropping season over two years",
    ),
    Scenario(
        "when-dry-periods", "when",
        ["LISS-4 scenes over the area on the map from dry periods last year"],
        [c.asks_a_question()],
        area=DELHI,
        about="a meaning that depends on weather the app has no data for: ask, do not guess",
    ),
    Scenario(
        "when-around-event", "when",
        ["Show me scenes over the area on the map just before and just after 30 July 2024"],
        [c.years(2024, 2024), c.months(6, 7, 8, 9)],
        area=DELHI,
        about="the nearest scenes on each side of a date",
        later=True,
    ),
    Scenario(
        "when-one-a-month", "when",
        ["One scene a month over the area on the map for 2024"],
        [c.years(2024, 2024), c.one_per_month()],
        area=DELHI,
        about="one scene per period instead of every scene",
        later=True,
    ),
    Scenario(
        "when-yesterday", "when",
        ["Is there anything over the area on the map from yesterday?"],
        [c.answer_says("weekly", "week", "up to a week", "catalogue is updated")],
        area=DELHI,
        about="the catalogue's lag is stated instead of an empty result",
    ),

    # --- 3. what kind of scene ----------------------------------------------
    Scenario(
        "kind-cloud-free", "what kind",
        ["Only cloud-free Sentinel-2 scenes over the area on the map from 2026"],
        [c.answer_says("no cloud", "cloud cover is not", "does not hold cloud", "quicklook")],
        area=DELHI,
        about="cloud cover is not in the data: say so plainly, do not invent a filter",
    ),
    Scenario(
        "kind-product-level", "what kind",
        ["Sentinel-2 Level-2A scenes only, over the area on the map, August 2026"],
        [c.product_level("Level-2A"), c.years(2026, 2026)],
        area=DELHI,
        about="a product level the catalogue does hold on every scene",
    ),
    Scenario(
        "kind-sentinel1-grd", "what kind",
        ["Sentinel-1 GRD scenes over the area on the map from 2026"],
        [c.searched("Sentinel-1A", "Sentinel-1C", "Sentinel-1D"), c.product_level("GRD")],
        area=DELHI,
        about="the same for radar, where GRD and SLC share a collection",
    ),
    Scenario(
        "kind-downloadable-now", "what kind",
        ["Only the scenes I can download right now, over the area on the map, from 2026"],
        [c.availability("Ready"), c.years(2026, 2026)],
        area=DELHI,
        about="availability as a filter, not a count in the summary",
    ),
    Scenario(
        "kind-covers-area", "what kind",
        ["Scenes that cover the whole area on the map, LISS-4, 2025"],
        [c.sensor_is("LISS4"), c.covers_area(DELHI_RING)],
        area=DELHI,
        about="cover the area, not touch a corner of it",
    ),
    Scenario(
        "kind-ascending", "what kind",
        ["Only ascending passes of Sentinel-1 over the area on the map in 2026"],
        [c.answer_says("not", "no ", "cannot", "unavailable")],
        area=DELHI,
        about="pass direction is not in the data: say what is and is not available",
    ),

    # --- 4. where ------------------------------------------------------------
    Scenario(
        "where-city", "where",
        ["Sentinel-2 scenes over Shillong in August 2026"],
        [c.used_tool("resolve_location"), c.searched("Sentinel-2A", "Sentinel-2B", "Sentinel-2C")],
        about="a city by name",
    ),
    Scenario(
        "where-map-area", "where",
        ["LISS-4 scenes here from 2025"],
        [c.area_used(MATHURA_CIRCLE["lon"], MATHURA_CIRCLE["lat"]), c.sensor_is("LISS4")],
        area=MATHURA_CIRCLE,
        about="no place named: the area on the map is the ground",
    ),
    Scenario(
        "where-named-place-wins", "where",
        ["LISS-4 scenes over Agra from 2025"],
        [c.used_tool("resolve_location"),
         c.area_used(MATHURA_CIRCLE["lon"], MATHURA_CIRCLE["lat"], expected=False)],
        area=MATHURA_CIRCLE,
        about="a place in the message replaces the area on the map",
    ),
    Scenario(
        "where-district", "where",
        ["LISS-3 scenes over Mathura district in 2025"],
        [c.used_tool("resolve_location"), c.sensor_is("LISS3")],
        about="a district: the real outline, not a box a third larger",
        later=True,
    ),
    Scenario(
        "where-river", "where",
        ["Scenes along the Yamuna river from 2026"],
        [c.asks_a_question()],
        about="a long thin feature: a strip along it, or a question back",
        later=True,
    ),
    Scenario(
        "where-upload", "where",
        ["I want to search my own boundary file"],
        [],
        about="a GeoJSON, KML or shapefile boundary",
        screen=True, later=True,
    ),
    Scenario(
        "where-compare-two", "where",
        ["Compare what Sentinel-2 has over Delhi and over Mumbai in August 2026"],
        [c.searched_twice_apart()],
        about="two places at once, both kept on the map",
        later=True,
    ),

    # --- 5. talking about the results ---------------------------------------
    Scenario(
        "talk-narrow-ready", "talking",
        ["LISS-4 scenes over the area on the map from 2025", "only the Ready ones"],
        [c.availability("Ready"), c.sensor_is("LISS4")],
        area=DELHI,
        about="narrowing what is already on screen",
    ),
    Scenario(
        "talk-now-for-agra", "talking",
        ["Sentinel-2 scenes over Delhi in August 2026", "now for Agra"],
        [c.used_tool("resolve_location"), c.searched("Sentinel-2A", "Sentinel-2B", "Sentinel-2C")],
        about="a follow-up that changes only the place",
    ),
    Scenario(
        "talk-radar-instead", "talking",
        ["Sentinel-2 scenes over the area on the map in September 2026", "radar instead"],
        [c.kept(start_date="2026-09-01")],
        area=DELHI,
        about="a follow-up that changes only the satellite kind",
    ),
    Scenario(
        "talk-about-this-scene", "talking",
        ["Tell me about this scene"],
        [],
        area=DELHI,
        about="the selected scene goes with the message",
        screen=True, later=True,
    ),
    Scenario(
        "talk-which-sensor", "talking",
        ["Which sensor should I use for flood mapping in Assam?"],
        [c.used_tool("list_collections")],
        about="advice grounded in the collection records, then a search",
        later=True,
    ),
    Scenario(
        "talk-why-nothing", "talking",
        ["Sentinel-1B scenes over the area on the map from 2024"],
        [c.answer_says("2021", "ended", "stopped", "no longer")],
        area=DELHI,
        about="an empty result gets its reason: Sentinel-1B stopped in 2021",
    ),

    # --- 6. getting the data -------------------------------------------------
    Scenario(
        "data-download-command", "getting the data",
        ["LISS-4 scenes over the area on the map from 2025", "give me the command to download these"],
        [c.used_tool("bhd_command"), c.answer_says("bhd query create"),
         c.answer_avoids("bhoonidhi download", "wget", "curl -o")],
        area=MATHURA_CIRCLE,
        about="the hand-off commands, shown as the tool returns them",
    ),
    Scenario(
        "data-priced", "getting the data",
        ["Cartosat-3 scenes over the area on the map from 2026"],
        [c.answer_says("priced", "paid", "order")],
        area=DELHI,
        about="priced scenes are named as priced, not as ready",
    ),
    Scenario(
        "data-export", "getting the data",
        ["Export this list as CSV and the footprints as GeoJSON"],
        [],
        about="export for QGIS from what the browser already holds",
        screen=True, later=True,
    ),
    Scenario(
        "data-share", "getting the data",
        ["Share this search with a colleague"],
        [],
        about="a conversation belongs to one browser today",
        screen=True, later=True,
    ),

    # --- 7. looking at scenes ------------------------------------------------
    Scenario(
        "look-quicklooks", "looking",
        ["Show me the quicklooks"],
        [],
        about="judging scenes by their quicklook, one at a time today",
        screen=True, later=True,
    ),
    Scenario(
        "look-compare-dates", "looking",
        ["Compare these two dates side by side"],
        [],
        about="the design system's swipe comparison, not wired",
        screen=True, later=True,
    ),
]


def selected(groups: list[str] | None = None, ids: list[str] | None = None, everything: bool = False) -> list[Scenario]:
    """The scenarios to run: by default the ones this slice covers."""
    out = [s for s in SCENARIOS if everything or not (s.later or s.screen)]
    if groups:
        out = [s for s in out if s.group in groups]
    if ids:
        out = [s for s in SCENARIOS if s.id in ids]
    return out
