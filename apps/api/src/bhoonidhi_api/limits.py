"""Per-visitor request limits for the routes that cost something upstream:
the model (questions), the catalogue (searches), ISRO's server (quicklooks)
and Nominatim (place searches).

Counts are kept in memory, per visitor address, over the last minute. That
is enough for the single server process the image runs; several processes
would each keep their own counts. The address is the header CLIENT_IP_HEADER
names, or the connection's address when it is empty (see config.py).
"""
from __future__ import annotations

import time
from collections import deque

from fastapi import HTTPException, Request

from .config import settings

WINDOW_S = 60.0


def visitor(request: Request) -> str:
    """The address a request is counted against."""
    if settings.client_ip_header:
        value = request.headers.get(settings.client_ip_header, "").strip()
        if value:
            return value
    return request.client.host if request.client else "unknown"


class Limit:
    def __init__(self, per_minute: int) -> None:
        self.per_minute = per_minute
        self._hits: dict[str, deque[float]] = {}

    async def __call__(self, request: Request) -> None:
        # async, so FastAPI runs it on the event loop, where the check and the
        # append below cannot interleave with another request's.
        key = visitor(request)
        now = time.monotonic()
        hits = self._hits.setdefault(key, deque())
        while hits and hits[0] <= now - WINDOW_S:
            hits.popleft()
        if len(hits) >= self.per_minute:
            wait = int(hits[0] + WINDOW_S - now) + 1
            raise HTTPException(
                status_code=429,
                detail=f"Too many requests, try again in {wait} s",
                headers={"Retry-After": str(wait)},
            )
        hits.append(now)
        if len(self._hits) > 10_000:
            self._forget(now)

    def _forget(self, now: float) -> None:
        # Visitors with nothing in the last minute.
        for key in [k for k, v in self._hits.items() if not v or v[-1] <= now - WINDOW_S]:
            del self._hits[key]


QUESTIONS = Limit(6)
SEARCHES = Limit(30)
QUICKLOOKS = Limit(60)
PLACES = Limit(20)
