"""A question waiting for the model, read into a form query without it (the
nudge): only what the question names plainly, over the previous search."""
from datetime import date

from bhoonidhi_api import query
from bhoonidhi_api.names import Collection


def _col(platform, sat, sensor, levels=("L2",)):
    return Collection(
        id=f"{platform}-{sensor.lower()}", platform=platform, satellite=sat, sensor=sensor,
        products=tuple(f"{sat}_{sensor}_{lv}" for lv in levels),
    )


# Enough of the catalogue's shape: families, a shared sensor, levels.
CAT = [
    _col("sentinel-1a", "Sentinel-1A", "SAR(IW)", ("GRD", "SLC")),
    _col("sentinel-2a", "Sentinel-2A", "MSI", ("Level-1C", "Level-2A")),
    _col("sentinel-2b", "Sentinel-2B", "MSI", ("Level-1C", "Level-2A")),
    # Launched later: no scenes before 2025.
    Collection(id="sentinel-2c-msi", platform="sentinel-2c", satellite="Sentinel-2C", sensor="MSI",
               start="2025-02-23", end="2026-09-26",
               products=("Sentinel-2C_MSI_Level-1C", "Sentinel-2C_MSI_Level-2A")),
    _col("landsat-8", "LandSat-8", "OLI+TIRS"),
    _col("landsat-9", "LandSat-9", "OLI+TIRS"),
    _col("resourcesat-1", "ResourceSat-1", "LISS4(MONO)"),
    _col("resourcesat-2", "ResourceSat-2", "LISS4(MX23)"),
    _col("resourcesat-2", "ResourceSat-2", "LISS4(MX70)"),
    _col("resourcesat-2", "ResourceSat-2", "AWIFS"),
    _col("eos-04", "EOS-04", "SAR(CRS)"),
]

BASE = {
    "items": [{"satellite": "EOS-04"}],
    "area": {"kind": "bbox", "west": 77, "south": 12, "east": 78, "north": 13},
    "covers_area": False,
    "dates": {"from": "2026-08-01", "to": "2026-08-31", "yearly": False},
    "availability": None,
    "max_resolution_m": None,
}


def ask(text, area=None):
    return query.from_question(text, BASE, area, CAT)


def test_names_levels_and_a_month_are_read():
    q = ask("Sentinel-2 L2A over Bengaluru in March 2023")
    assert q["items"] == [
        {"satellite": "Sentinel-2A", "sensor": "MSI", "product": "Level-2A"},
        {"satellite": "Sentinel-2B", "sensor": "MSI", "product": "Level-2A"},
    ]
    assert q["dates"] == {"from": "2023-03-01", "to": "2023-03-31", "yearly": False}


def test_a_number_after_and_is_another_satellite_of_the_line():
    q = ask("landsat 8 and 9 from 2019 to 2021")
    assert q["items"] == [{"satellite": "LandSat-8"}, {"satellite": "LandSat-9"}]
    assert q["dates"] == {"from": "2019-01-01", "to": "2021-12-31", "yearly": False}


def test_ready_and_resolution_are_read():
    q = ask("any LISS-4 imagery under 6 m that is ready to download")
    # ResourceSat-1 carries only LISS-4 here, so the whole satellite is taken.
    assert q["items"] == [
        {"satellite": "ResourceSat-1"},
        {"satellite": "ResourceSat-2", "sensor": "LISS4(MX23)"},
        {"satellite": "ResourceSat-2", "sensor": "LISS4(MX70)"},
    ]
    assert q["availability"] == "Ready"
    assert q["max_resolution_m"] == 6.0
    assert ask("EOS-04 data, 10m or better")["max_resolution_m"] == 10.0


def test_what_the_question_does_not_name_keeps_the_previous_search():
    q = ask("What images do you have of this land?")
    assert q == BASE
    # Only the dates change here; the satellite stays EOS-04.
    assert ask("and in 2024?")["items"] == BASE["items"]


def test_the_map_area_replaces_the_previous_one():
    area = {"kind": "circle", "lon": 80, "lat": 20, "radius_km": 5}
    assert ask("Sentinel 1", area)["area"] == area


def test_a_satellite_with_no_scenes_in_the_dates_is_left_out():
    # Sentinel-2C only has scenes from 2025: a 2023 question searches 2A and 2B.
    q = ask("Sentinel-2 L2A in March 2023")
    assert [i["satellite"] for i in q["items"]] == ["Sentinel-2A", "Sentinel-2B"]
    assert [i["satellite"] for i in ask("Sentinel-2 L2A in March 2026")["items"]] == [
        "Sentinel-2A", "Sentinel-2B", "Sentinel-2C",
    ]


def test_dates_stop_at_today(monkeypatch):
    # The date in India, as the agent's own prompt uses it: just after
    # midnight there, the UTC date is still the day before.
    monkeypatch.setattr(query.tools, "today", lambda: date(2026, 10, 2))
    q = ask("Sentinel-2 in 2026")
    assert q["dates"] == {"from": "2026-01-01", "to": "2026-10-02", "yearly": False}
    # A year already over keeps its whole span.
    assert ask("Sentinel-2 in 2025")["dates"]["to"] == "2025-12-31"
