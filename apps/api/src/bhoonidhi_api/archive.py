"""The portal's own catalogue of satellites, sensors and product levels, read
from the cache `bhd` keeps at ``~/.bhoonidhi/archive.json``.

This is where product levels come from. The STAC catalogue stores a scene's
level only inside its SELECTION value, so the only other source is a sample
of items, and a sample can miss a level entirely (Sentinel-2A's Level-2A, for
one), which makes a search for that level under-count. The archive lists
every product the portal offers, including every value seen in items.

Nothing here touches the network: the file is written by `bhd archive` when
the user runs it, and the explorer's API only reads it. A missing or unreadable
cache is not an error; the caller falls back to what the items show.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

# `bhd`'s own cache location and its parser for the raw records, so the two
# can never drift apart. Importing the parser is not a network call.
from bhoonidhi_downloader.core.archive.client import ARCHIVE_PATH, ArchiveManager


def read(path: Path | None = None) -> list[dict[str, Any]]:
    """The archive as `bhd archive export` writes it, or an empty list when
    the cache is missing or unreadable."""
    import json

    try:
        raw = json.loads((path or ARCHIVE_PATH).read_text())
    except (OSError, ValueError):
        return []
    if not isinstance(raw, list):
        return []
    try:
        return ArchiveManager.format_archive(raw)
    except (KeyError, TypeError, ValueError):
        return []


def selections(path: Path | None = None) -> dict[str, tuple[str, ...]]:
    """Every product a satellite and sensor offers, keyed by
    ``"<satellite>_<sensor>"``, each value the full SELECTION strings::

        {"Sentinel-2A_MSI": ("Sentinel-2A_MSI_Level-1C", "Sentinel-2A_MSI_Level-2A")}

    A sensor whose scenes carry no level at all (``Aqua_MODIS``) maps to its
    own bare name, which carries no level and so filters nothing.
    """
    out: dict[str, list[str]] = {}
    for satellite in read(path):
        for entry in satellite.get("collections") or []:
            for disp_name, meta in entry.items():
                key = f"{satellite.get('satellite')}_{meta.get('sensor')}"
                out.setdefault(key, []).append(disp_name)
    return {k: tuple(dict.fromkeys(v)) for k, v in out.items()}
