import asyncio

import pytest
from fastapi import HTTPException, Request

from bhoonidhi_api import limits


def _from(host: str, headers: dict[str, str] | None = None) -> Request:
    raw = [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()]
    return Request({"type": "http", "client": (host, 50000), "headers": raw})


def test_refuses_past_the_limit_with_a_wait(monkeypatch):
    monkeypatch.setattr(limits.time, "monotonic", lambda: 1000.0)
    limit = limits.Limit(2)
    asyncio.run(limit(_from("a")))
    asyncio.run(limit(_from("a")))
    with pytest.raises(HTTPException) as refused:
        asyncio.run(limit(_from("a")))
    assert refused.value.status_code == 429
    assert refused.value.detail == "Too many requests, try again in 61 s"
    assert refused.value.headers == {"Retry-After": "61"}


def test_counts_each_visitor_apart(monkeypatch):
    monkeypatch.setattr(limits.time, "monotonic", lambda: 1000.0)
    limit = limits.Limit(1)
    asyncio.run(limit(_from("a")))
    asyncio.run(limit(_from("b")))


def test_a_minute_later_it_allows_again(monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(limits.time, "monotonic", lambda: now[0])
    limit = limits.Limit(1)
    asyncio.run(limit(_from("a")))
    now[0] += limits.WINDOW_S
    asyncio.run(limit(_from("a")))


def test_by_default_the_connection_address_counts(monkeypatch):
    """A header the visitor can write does not change who is counted."""
    monkeypatch.setattr(limits.settings, "client_ip_header", "")
    assert limits.visitor(_from("198.51.100.7", {"Cf-Connecting-Ip": "203.0.113.1"})) == "198.51.100.7"


def test_the_named_header_counts_when_set(monkeypatch):
    """Behind Cloudflare every request arrives from the tunnel; the header it
    writes tells visitors apart."""
    monkeypatch.setattr(limits.settings, "client_ip_header", "Cf-Connecting-Ip")
    monkeypatch.setattr(limits.time, "monotonic", lambda: 1000.0)
    limit = limits.Limit(1)
    asyncio.run(limit(_from("192.0.2.2", {"Cf-Connecting-Ip": "203.0.113.1"})))
    asyncio.run(limit(_from("192.0.2.2", {"Cf-Connecting-Ip": "203.0.113.2"})))
    with pytest.raises(HTTPException):
        asyncio.run(limit(_from("192.0.2.2", {"Cf-Connecting-Ip": "203.0.113.1"})))
    # A request without the header counts against the connection's address.
    assert limits.visitor(_from("192.0.2.2")) == "192.0.2.2"
