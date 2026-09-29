"""Place search for the palette's @ mode, through Nominatim, the geocoder the
agent's resolve_location uses. Its usage policy sets the rules here: one request
a second, a named User-Agent, cached results, and no search-as-you-type.
"""
from __future__ import annotations

import asyncio
import time
from typing import Any

import httpx

from .config import settings

_MIN_INTERVAL = 1.1  # seconds between upstream requests
_CACHE_SIZE = 256

_lock = asyncio.Lock()
_last_request = 0.0
_cache: dict[tuple[str, int], list[dict[str, Any]]] = {}


def _shape(item: dict[str, Any]) -> dict[str, Any] | None:
    try:
        south, north, west, east = (float(v) for v in item["boundingbox"])
        lat, lon = float(item["lat"]), float(item["lon"])
    except (KeyError, TypeError, ValueError):
        return None
    display = item.get("display_name") or ""
    return {
        "name": item.get("name") or display.split(",")[0],
        "detail": display,
        "kind": item.get("addresstype") or item.get("type"),
        "lat": lat,
        "lon": lon,
        "bbox": {"west": west, "south": south, "east": east, "north": north},
    }


async def search(query: str, limit: int = 5) -> list[dict[str, Any]]:
    """Places matching a name, best match first."""
    global _last_request
    q = " ".join(query.split())
    key = (q.lower(), limit)
    if key in _cache:
        return _cache[key]
    async with _lock:
        # Another request may have filled it while this one waited.
        if key in _cache:
            return _cache[key]
        wait = _MIN_INTERVAL - (time.monotonic() - _last_request)
        if wait > 0:
            await asyncio.sleep(wait)
        try:
            async with httpx.AsyncClient(
                base_url=settings.geocoder_url,
                timeout=15,
                headers={"User-Agent": settings.geocoder_user_agent},
            ) as client:
                r = await client.get("/search", params={"q": q, "format": "jsonv2", "limit": limit})
        finally:
            _last_request = time.monotonic()
        r.raise_for_status()
        places = [p for p in (_shape(i) for i in r.json()) if p]
        if len(_cache) >= _CACHE_SIZE:
            _cache.pop(next(iter(_cache)))
        _cache[key] = places
    return places
