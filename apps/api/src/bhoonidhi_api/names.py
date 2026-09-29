"""Satellite and sensor names, as people write them, to catalogue collections.

The catalogue has one collection per satellite and sensor (79 of them, e.g.
``resourcesat-2a-liss4-mx23``). A name is tried in this order, and the first
level that matches wins:

1. an exact satellite: "ResourceSat-2A", "resourcesat 2a", "EOS 4" -> that one
   satellite only, never its siblings;
2. a family: "Sentinel-2", "IRS-1" -> every satellite in it (2A, 2B, 2C);
3. a brand: "resourcesat", "landsat" -> every satellite of that line;
4. a sensor written where a satellite was expected: "LISS-3", "MODIS" -> the
   satellites carrying it;
5. the start of a brand, when only one brand starts that way: "carto";
6. a satellite and a sensor in one string: "NISAR SAR", "Sentinel-2 MSI".

Common alternative names (IRS-P6, RISAT-1A, Oceansat-3, S2, L8, LISS-IV, OLI)
are rewritten to the catalogue's names first. Several names can be joined with
"and", "&", "/" or commas. Everything is built from the catalogue's own list,
so it cannot drift from what the catalogue holds.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field


@dataclass(frozen=True)
class Collection:
    id: str
    # Catalogue platform, e.g. "resourcesat-2a".
    platform: str
    # The portal's names, as `bhd` expects them, e.g. "ResourceSat-2A" and
    # "LISS4(MX23)".
    satellite: str
    sensor: str
    gsd_m: float | None = None
    start: str | None = None
    end: str | None = None
    # Every SELECTION value seen in this collection, e.g.
    # ("Sentinel-2A_MSI_Level-1C", "Sentinel-2A_MSI_Level-2A"). One collection
    # can hold several product levels, so this is what a level filter matches
    # against.
    products: tuple[str, ...] = ()


def norm(text: str) -> str:
    """Lower case, letters and digits only, no leading zeros: "EOS-04" -> "eos4"."""
    s = re.sub(r"[^a-z0-9]", "", text.lower())
    return re.sub(r"(?<![0-9])0+(?=[0-9])", "", s)


def _family(platform_norm: str) -> str:
    # Sentinel-1A -> sentinel1, CartoSat-2S -> cartosat2.
    return re.sub(r"(?<=\d)[a-z]+$", "", platform_norm)


def _brand(platform_norm: str) -> str:
    # ResourceSat-2A -> resourcesat, NOAA-19 -> noaa.
    return re.sub(r"\d.*$", "", platform_norm)


def _stem(sensor: str) -> str:
    # LISS4(MX23) -> liss4, SAR(IW) -> sar, OLI+TIRS -> olitirs.
    return norm(sensor.split("(")[0])


# Names people use that the catalogue spells differently. Values are
# catalogue names (normalised) or lists of them.
SATELLITE_ALIASES: dict[str, str | list[str]] = {
    "s1": "sentinel1",
    "s2": "sentinel2",
    "sen1": "sentinel1",
    "sen2": "sentinel2",
    "l8": "landsat8",
    "l9": "landsat9",
    "rs1": "resourcesat1",
    "irsp6": "resourcesat1",
    "rs2": "resourcesat2",
    "rs2a": "resourcesat2a",
    "r2a": "resourcesat2a",
    "risat1a": "eos4",
    "oceansat3": "eos6",
    "npp": "suominpp",
    "snpp": "suominpp",
    "noaa20": "jpss1",
    "metop": ["metopb", "metopc"],
    "radar": "sar",
}
SENSOR_ALIASES: dict[str, str] = {
    "lissiv": "liss4",
    "lissiii": "liss3",
    "oli": "olitirs",
    "tirs": "olitirs",
    "radar": "sar",
}
# "SAR" also means NISAR's SSAR.
SENSOR_GROUPS: dict[str, set[str]] = {"sar": {"sar", "ssar"}}

_SPLIT = re.compile(r"\s*(?:,|&|/|\band\b|\bplus\b)\s*", re.IGNORECASE)


def level_key(text: str) -> str:
    """A product level as a comparable key: "Level-2A", "L2A" and "level 2a"
    all become "l2a", so a user's spelling reaches the catalogue's."""
    s = norm(text)
    return re.sub(r"^level(?=\d)", "l", s)


def level_of(collection: Collection, selection: str) -> str:
    """The level at the end of a SELECTION value: "Sentinel-2A_MSI_Level-2A"
    over the Sentinel-2A MSI collection is "Level-2A". A collection whose
    scenes carry no level ("Aqua_MODIS") gives an empty string."""
    prefix = f"{collection.satellite}_{collection.sensor}"
    return selection[len(prefix):].lstrip("_") if selection.startswith(prefix) else ""


def levels(collection: Collection) -> list[str]:
    """The product levels a collection holds, in catalogue order, once."""
    seen = (level_of(collection, s) for s in collection.products)
    return list(dict.fromkeys(x for x in seen if x))


def _spellings(catalogue: list[Collection]) -> dict[tuple[str, str], set[str]]:
    """How each sensor spells each product level: ("MSI", "l2a") -> {"Level-2A"}.

    Levels are learned from a sample of each collection's items, and a sample
    can miss a level its collection does hold (the newest Sentinel-2A scenes
    can all be Level-1C while the collection also holds Level-2A). Sister
    collections of the same sensor spell a level identically, so pooling the
    spellings per sensor recovers what any one sample missed.
    """
    out: dict[tuple[str, str], set[str]] = {}
    for c in catalogue:
        for lv in levels(c):
            out.setdefault((c.sensor, level_key(lv)), set()).add(lv)
    return out


@dataclass
class Resolved:
    collections: list[Collection] = field(default_factory=list)
    # Names that matched nothing.
    unknown: list[str] = field(default_factory=list)
    # Product levels named, as the user wrote them.
    products: list[str] = field(default_factory=list)
    # The exact SELECTION values those levels select, across the chosen
    # collections. Empty when no level was named; a search filters on these.
    selections: list[str] = field(default_factory=list)
    # Levels named that none of the chosen collections holds, with what they
    # do hold, so the answer can say so instead of returning nothing.
    missing_products: list[str] = field(default_factory=list)


def _sensor_match(term: str, catalogue: list[Collection]) -> list[Collection]:
    t = SENSOR_ALIASES.get(term, term)
    stems = SENSOR_GROUPS.get(t, {t})
    return [c for c in catalogue if norm(c.sensor) == t or _stem(c.sensor) in stems]


def _satellite_match(term: str, catalogue: list[Collection]) -> list[Collection]:
    alias = SATELLITE_ALIASES.get(term, term)
    if isinstance(alias, list):
        return [c for a in alias for c in _satellite_match(a, catalogue)]
    t = alias
    for key in (lambda c: norm(c.platform), lambda c: _family(norm(c.platform)), lambda c: _brand(norm(c.platform))):
        hits = [c for c in catalogue if key(c) == t]
        if hits:
            return hits
    hits = _sensor_match(t, catalogue)
    if hits:
        return hits
    # A shortened brand, when only one brand starts that way: "carto".
    if len(t) >= 4 and t.isalpha():
        brands = {_brand(norm(c.platform)) for c in catalogue if _brand(norm(c.platform)).startswith(t)}
        if len(brands) == 1:
            return _satellite_match(brands.pop(), catalogue)
    return []


def _satellite_and_sensor(term: str, catalogue: list[Collection]) -> list[Collection]:
    """A satellite and a sensor written together, "NISAR SAR" or "Sentinel-2
    MSI": the longest leading words that name a satellite, the rest a sensor."""
    words = term.split()
    for cut in range(len(words) - 1, 0, -1):
        sats = _satellite_match(norm(" ".join(words[:cut])), catalogue)
        sens = _sensor_match(norm(" ".join(words[cut:])), catalogue)
        ids = {c.id for c in sens}
        both = [c for c in sats if c.id in ids]
        if both:
            return both
    return []


def _terms(text: str | None) -> list[str]:
    """The names in a list: "Landsat 8 and 9" -> ["Landsat 8", "Landsat 9"].
    A bare number or platform letter takes the brand of the name before it."""
    if not text:
        return []
    out: list[str] = []
    for part in (p.strip() for p in _SPLIT.split(text.strip())):
        if not part:
            continue
        if out and re.fullmatch(r"\d+[A-Za-z]?|[A-Za-z]", part):
            brand = re.sub(r"[\s-]*\d.*$", "", out[-1])
            part = f"{brand} {part}" if part[0].isdigit() else f"{re.sub(r'[A-Za-z]$', '', out[-1])}{part}"
        out.append(part)
    return out


def resolve(
    satellite: str | None,
    sensor: str | None,
    catalogue: list[Collection],
    product_level: str | None = None,
) -> Resolved:
    """The collections a satellite and sensor name select. No satellite means
    every satellite; no sensor means every sensor of the chosen satellites.

    A product level is matched against the levels those collections
    hold, whatever spelling each uses ("Level-2A" for Sentinel-2, "L2" for
    AWiFS), and returns the exact SELECTION values to filter on.
    """
    out = Resolved()
    chosen: list[Collection] = []
    sat_terms = _terms(satellite)
    for term in sat_terms:
        hits = _satellite_match(norm(term), catalogue) or _satellite_and_sensor(term, catalogue)
        if hits:
            chosen.extend(hits)
        else:
            out.unknown.append(term)
    if not sat_terms:
        chosen = list(catalogue)

    # A level written into the sensor field ("LISS-4 L2") is taken as a level.
    spellings = _spellings(catalogue)
    known_levels = {key for _, key in spellings}
    sensor_terms = []
    level_terms = _terms(product_level)
    for term in _terms(sensor):
        if level_key(term) in known_levels:
            level_terms.append(term)
        else:
            sensor_terms.append(term)
    if sensor_terms:
        by_sensor: list[Collection] = []
        for term in sensor_terms:
            hits = _sensor_match(norm(term), catalogue)
            if hits:
                by_sensor.extend(hits)
            else:
                out.unknown.append(term)
        ids = {c.id for c in by_sensor}
        chosen = [c for c in chosen if c.id in ids]

    seen: set[str] = set()
    out.collections = [c for c in chosen if not (c.id in seen or seen.add(c.id))]

    for term in level_terms:
        out.products.append(term)
        key = level_key(term)
        # The exact SELECTION value each chosen collection uses for this
        # level, built from the sensor's spellings rather than read from that
        # one collection's sample, which may not have shown the level at all.
        hits = [
            f"{c.satellite}_{c.sensor}_{lv}"
            for c in out.collections
            for lv in sorted(spellings.get((c.sensor, key), ()))
        ]
        if hits:
            out.selections.extend(hits)
        else:
            out.missing_products.append(term)
    out.selections = list(dict.fromkeys(out.selections))
    return out


def satellites(catalogue: list[Collection]) -> list[str]:
    """Every satellite name, in catalogue order, once."""
    return list(dict.fromkeys(c.satellite for c in catalogue))
