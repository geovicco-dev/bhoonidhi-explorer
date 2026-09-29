"""The name resolver: the ways people and models write a satellite or
sensor, against a catalogue built like the real one."""
from bhoonidhi_api import names
from bhoonidhi_api.names import Collection


# One entry per collection, shaped like the live catalogue (79 there; enough
# here to cover families, aliases and shared sensors). `products` holds the
# SELECTION values a collection's scenes carry, which is where product levels
# are read from; each family spells them its own way.
def _products(sat, sensor):
    levels = {
        "MSI": ["Level-1C", "Level-2A"],
        "SAR(IW)": ["GRD", "SLC"],
        "SSAR": ["RSLC", "GSLC", "GCOV"],
        "AWIFS": ["", "L2"],
    }.get(sensor, ["L2"])
    return tuple(f"{sat}_{sensor}_{lv}" if lv else f"{sat}_{sensor}" for lv in levels)


CAT = [
    Collection(
        id=f"{p}-{s.lower().replace('(', '-').replace(')', '').replace('+', '-')}",
        platform=p, satellite=sat, sensor=s, products=_products(sat, s),
    )
    for p, sat, sensors in [
        ("resourcesat-1", "ResourceSat-1", ["AWIFS", "LISS3", "LISS4(MONO)", "LISS4(MX70)"]),
        ("resourcesat-2", "ResourceSat-2", ["AWIFS", "LISS3", "LISS4(MX23)", "LISS4(MX70)"]),
        ("resourcesat-2a", "ResourceSat-2A", ["AWIFS", "LISS3", "LISS4(MX23)", "LISS4(MX70)"]),
        ("irs-1c", "IRS-1C", ["LISS3", "PAN", "WIFS"]),
        ("sentinel-1a", "Sentinel-1A", ["SAR(IW)"]),
        ("sentinel-1c", "Sentinel-1C", ["SAR(IW)"]),
        ("sentinel-1d", "Sentinel-1D", ["SAR(IW)"]),
        ("sentinel-2a", "Sentinel-2A", ["MSI"]),
        ("sentinel-2b", "Sentinel-2B", ["MSI"]),
        ("landsat-8", "LandSat-8", ["OLI+TIRS"]),
        ("landsat-9", "LandSat-9", ["OLI+TIRS"]),
        ("eos-04", "EOS-04", ["SAR(CRS)", "SAR(MRS)"]),
        ("eos-06", "EOS-06", ["OCM(GAC)", "OCM(LAC)"]),
        ("oceansat-2", "OceanSat-2", ["OCM(GAC)"]),
        ("nisar", "NISAR", ["SSAR"]),
        ("cartosat-2s", "CartoSat-2S", ["PAN(SPOT)"]),
        ("cartosat-3", "CartoSat-3", ["PAN(SPOT)", "MX(SPOT)"]),
        ("kompsat-3", "KompSat-3", ["MS"]),
        ("kompsat-3a", "KompSat-3A", ["MS"]),
        ("suomi-npp", "Suomi-NPP", ["VIIRS"]),
        ("jpss1", "JPSS1", ["VIIRS"]),
    ]
    for s in sensors
]


def pick(satellite, sensor=None):
    r = names.resolve(satellite, sensor, CAT)
    return sorted({f"{c.satellite} {c.sensor}" for c in r.collections}), r.unknown


def sats(satellite, sensor=None):
    return sorted({c.satellite for c in names.resolve(satellite, sensor, CAT).collections})


def test_exact_name_stays_exact():
    # An exact satellite name must not widen to its whole family.
    assert sats("ResourceSat-2A") == ["ResourceSat-2A"]
    assert sats("KompSat-3A") == ["KompSat-3A"]
    assert sats("IRS-1C") == ["IRS-1C"]
    assert sats("Sentinel-1C") == ["Sentinel-1C"]


def test_spelling_variants():
    for written in ["resourcesat-2a", "Resourcesat 2A", "RESOURCESAT2A", "RS2A", "RS-2A"]:
        assert sats(written) == ["ResourceSat-2A"], written
    assert sats("Sentinel 1-A") == ["Sentinel-1A"]


def test_family_and_brand():
    assert sats("Sentinel-1") == ["Sentinel-1A", "Sentinel-1C", "Sentinel-1D"]
    assert sats("S2") == ["Sentinel-2A", "Sentinel-2B"]
    assert sats("resourcesat") == ["ResourceSat-1", "ResourceSat-2", "ResourceSat-2A"]
    assert sats("landsat") == ["LandSat-8", "LandSat-9"]


def test_aliases():
    assert sats("RISAT-1A") == ["EOS-04"]
    assert sats("Oceansat-3") == ["EOS-06"]
    assert sats("IRS-P6") == ["ResourceSat-1"]
    assert sats("L8") == ["LandSat-8"]


def test_several_names_in_one_string():
    assert sats("Landsat 8 and 9") == ["LandSat-8", "LandSat-9"]
    assert sats("Sentinel-1C, Sentinel-1D") == ["Sentinel-1C", "Sentinel-1D"]
    assert sats("Sentinel-2A & 2B") == ["Sentinel-2A", "Sentinel-2B"]


def test_sensor_spellings():
    assert pick("resourcesat 2a", "LISS-IV")[0] == ["ResourceSat-2A LISS4(MX23)", "ResourceSat-2A LISS4(MX70)"]
    assert pick("ResourceSat-2A", "liss4")[0] == pick("ResourceSat-2A", "LISS 4")[0]
    assert pick("RS2A", "AWiFS")[0] == ["ResourceSat-2A AWIFS"]


def test_his_prompt_liss4_across_resourcesat():
    got, unknown = pick("resourcesat", "liss4")
    assert unknown == []
    assert got == [
        "ResourceSat-1 LISS4(MONO)", "ResourceSat-1 LISS4(MX70)",
        "ResourceSat-2 LISS4(MX23)", "ResourceSat-2 LISS4(MX70)",
        "ResourceSat-2A LISS4(MX23)", "ResourceSat-2A LISS4(MX70)",
    ]


def test_sensor_as_satellite_name():
    # "radar", "VIIRS", "LISS-3" written where a satellite goes.
    assert sats("radar") == ["EOS-04", "NISAR", "Sentinel-1A", "Sentinel-1C", "Sentinel-1D"]
    assert sats("VIIRS") == ["JPSS1", "Suomi-NPP"]
    assert sats("LISS-3") == ["IRS-1C", "ResourceSat-1", "ResourceSat-2", "ResourceSat-2A"]
    assert sats(None, "LISS-3") == sats("LISS-3")


def test_satellite_and_sensor_together():
    assert pick("NISAR SAR")[0] == ["NISAR SSAR"]
    assert pick("Sentinel-2 MSI")[0] == ["Sentinel-2A MSI", "Sentinel-2B MSI"]


def test_short_brand():
    assert sats("carto") == ["CartoSat-2S", "CartoSat-3"]


def test_product_level_resolves_to_exact_selection_values():
    r = names.resolve("Sentinel-2", "L2A", CAT)
    assert r.unknown == [] and r.products == ["L2A"]
    assert {c.satellite for c in r.collections} == {"Sentinel-2A", "Sentinel-2B"}
    # "L2A" reaches the catalogue's own spelling, "Level-2A".
    assert r.selections == ["Sentinel-2A_MSI_Level-2A", "Sentinel-2B_MSI_Level-2A"]
    assert r.missing_products == []


def test_product_level_spellings_all_reach_the_same_scenes():
    for written in ("L2A", "l2a", "Level-2A", "level 2a", "LEVEL2A"):
        r = names.resolve("Sentinel-2B", None, CAT, written)
        assert r.selections == ["Sentinel-2B_MSI_Level-2A"], written


def test_slc_does_not_catch_rslc_or_gslc():
    """The reason for exact values instead of a `like '%SLC'`."""
    assert names.resolve("Sentinel-1A", None, CAT, "SLC").selections == ["Sentinel-1A_SAR(IW)_SLC"]
    assert names.resolve("NISAR", None, CAT, "RSLC").selections == ["NISAR_SSAR_RSLC"]
    assert names.resolve("NISAR", None, CAT, "SLC").selections == []


def test_a_level_the_satellite_does_not_have_is_reported():
    r = names.resolve("Sentinel-2B", None, CAT, "GRD")
    assert r.selections == [] and r.missing_products == ["GRD"]
    assert names.levels(r.collections[0]) == ["Level-1C", "Level-2A"]


def test_levels_ignore_scenes_that_carry_none():
    awifs = next(c for c in CAT if c.sensor == "AWIFS" and c.satellite == "ResourceSat-2")
    # "ResourceSat-2_AWIFS" has no level; "ResourceSat-2_AWIFS_L2" has one.
    assert names.levels(awifs) == ["L2"]


def test_unknown_names_reported_not_guessed():
    got, unknown = pick("Sentinel-5P")
    assert got == [] and unknown == ["Sentinel-5P"]
    got, unknown = pick("Landsat 8 and WorldView-3")
    assert got == ["LandSat-8 OLI+TIRS"] and unknown == ["WorldView-3"]


def test_satellite_without_that_sensor_is_empty_not_unknown():
    r = names.resolve("NISAR", "LISS-4", CAT)
    assert r.unknown == [] and r.collections == []


def test_no_names_means_everything():
    assert len(names.resolve(None, None, CAT).collections) == len(CAT)
