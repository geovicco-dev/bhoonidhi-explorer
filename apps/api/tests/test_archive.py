"""Reading the portal's product list from the `bhd` archive cache."""
from __future__ import annotations

import json

from bhoonidhi_api import archive

RAW = [
    {
        "satName": "Sentinel-2A",
        "priced": "X_DirectDownload",
        "thisMinRes": "10",
        "thisMaxRes": "10",
        "totalStartDate": "06/23/2015",
        "totalEndDate": "",
        "sensors": [
            {"senName": "MSI", "dispName": "Sentinel-2A_MSI_Level-1C", "res": "10",
             "stDate": "06/23/2015", "endDate": "", "products": "Level-1"},
            {"senName": "MSI", "dispName": "Sentinel-2A_MSI_Level-2A", "res": "10",
             "stDate": "06/23/2015", "endDate": "", "products": "Level-2"},
        ],
    },
    {
        "satName": "Aqua",
        "priced": "X_OnOrder",
        "thisMinRes": "500",
        "thisMaxRes": "500",
        "totalStartDate": "12/31/2003",
        "totalEndDate": "12/31/2019",
        # A sensor whose scenes carry no level at all.
        "sensors": [
            {"senName": "MODIS", "dispName": "Aqua_MODIS", "res": "500",
             "stDate": "12/31/2003", "endDate": "12/31/2019", "products": "Others"},
        ],
    },
]


def test_selections_are_keyed_by_satellite_and_sensor(tmp_path):
    path = tmp_path / "archive.json"
    path.write_text(json.dumps(RAW))
    got = archive.selections(path)
    assert got["Sentinel-2A_MSI"] == ("Sentinel-2A_MSI_Level-1C", "Sentinel-2A_MSI_Level-2A")
    # No level: the bare name, which carries none and so filters nothing.
    assert got["Aqua_MODIS"] == ("Aqua_MODIS",)


def test_a_missing_cache_is_not_an_error(tmp_path):
    """The user may never have run `bhd archive`; the catalogue then falls
    back to what the items themselves show."""
    assert archive.selections(tmp_path / "nothing.json") == {}
    assert archive.read(tmp_path / "nothing.json") == []


def test_a_corrupt_cache_is_not_an_error(tmp_path):
    path = tmp_path / "archive.json"
    path.write_text("{ this is not json")
    assert archive.selections(path) == {}
    path.write_text('{"Results": []}')
    assert archive.selections(path) == {}
