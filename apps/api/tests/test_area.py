"""Area of interest: the note the model gets, the chat request's area field,
and the place search's shaping, cache and rate limit."""
from __future__ import annotations

import asyncio

import httpx
import pytest
from pydantic import ValidationError

from bhoonidhi_api import geocode
from bhoonidhi_api.agent import area_note, system_prompt
from bhoonidhi_api.config import settings
from bhoonidhi_api.main import ChatRequest


def test_area_note_for_a_box_names_the_place_and_every_edge():
    note = area_note({"kind": "bbox", "west": 91.72, "south": 25.41, "east": 92.04, "north": 25.73, "name": "Shillong"})
    assert "west 91.7200" in note and "north 25.7300" in note
    assert "(Shillong)" in note
    # A place named in the message wins over the drawn area.
    assert "resolve_location" in note and "Never search the map area for a message that names a place" in note


def test_area_note_for_a_circle_passes_the_circle():
    note = area_note({"kind": "circle", "lon": 91.89, "lat": 25.58, "radius_km": 10})
    assert "circle of 10 km around lat 25.5800, lon 91.8900" in note
    # Searched as the exact circle, so no bounding box is offered.
    assert "lat, lon and radius_km" in note and "south" not in note


def test_no_area_no_note_and_the_system_prompt_carries_it():
    assert area_note(None) == ""
    area = {"kind": "bbox", "west": 1, "south": 2, "east": 3, "north": 4}
    assert area_note(area) in system_prompt(area)
    assert "area of interest" not in system_prompt(None)


def test_chat_request_accepts_both_shapes_and_rejects_bad_ones():
    box = ChatRequest.model_validate(
        {"message": "hi", "area": {"kind": "bbox", "west": 1, "south": 2, "east": 3, "north": 4}}
    )
    assert box.area is not None and box.area.kind == "bbox"
    circle = ChatRequest.model_validate(
        {"message": "hi", "area": {"kind": "circle", "lon": 91.9, "lat": 25.6, "radius_km": 15}}
    )
    assert circle.area is not None and circle.area.kind == "circle"
    assert ChatRequest.model_validate({"message": "hi"}).area is None
    # The portal's point search accepts 1 to 100 km.
    with pytest.raises(ValidationError):
        ChatRequest.model_validate({"message": "hi", "area": {"kind": "circle", "lon": 0, "lat": 0, "radius_km": 500}})
    with pytest.raises(ValidationError):
        ChatRequest.model_validate({"message": "hi", "area": {"kind": "polygon", "coordinates": []}})


NOMINATIM = [
    {
        "name": "Shillong",
        "display_name": "Shillong, Mylliem, East Khasi Hills, Meghalaya, 793001, India",
        "addresstype": "city",
        "lat": "25.5759931",
        "lon": "91.8827872",
        "boundingbox": ["25.4159931", "25.7359931", "91.7227872", "92.0427872"],
    },
    {"name": "broken", "lat": "x"},
]


@pytest.fixture
def fake_nominatim(monkeypatch):
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=NOMINATIM)

    transport = httpx.MockTransport(handler)
    real = httpx.AsyncClient

    def client(*args, **kwargs):
        kwargs["transport"] = transport
        return real(*args, **kwargs)

    monkeypatch.setattr(geocode.httpx, "AsyncClient", client)
    monkeypatch.setattr(geocode, "_cache", {})
    monkeypatch.setattr(geocode, "_last_request", 0.0)
    monkeypatch.setattr(geocode, "_MIN_INTERVAL", 0.0)
    monkeypatch.setattr(settings, "geocoder_url", "http://nominatim.test")
    return seen


def test_geocode_shapes_places_and_skips_broken_ones(fake_nominatim):
    places = asyncio.run(geocode.search("Shillong"))
    assert len(places) == 1
    p = places[0]
    assert p["name"] == "Shillong" and p["kind"] == "city"
    assert p["bbox"] == {"west": 91.7227872, "south": 25.4159931, "east": 92.0427872, "north": 25.7359931}
    # Nominatim's policy asks for an identifying User-Agent.
    assert fake_nominatim[0].headers["user-agent"] == settings.geocoder_user_agent


def test_geocode_caches_by_normalised_query(fake_nominatim):
    asyncio.run(geocode.search("Shillong"))
    asyncio.run(geocode.search("  shillong "))
    assert len(fake_nominatim) == 1


def test_geocode_waits_between_upstream_requests(fake_nominatim, monkeypatch):
    monkeypatch.setattr(geocode, "_MIN_INTERVAL", 0.2)
    sleeps: list[float] = []
    real_sleep = asyncio.sleep

    async def fake_sleep(seconds: float) -> None:
        sleeps.append(seconds)
        await real_sleep(0)

    monkeypatch.setattr(geocode.asyncio, "sleep", fake_sleep)

    async def two_lookups() -> None:
        await geocode.search("Shillong")
        await geocode.search("Loktak Lake")

    asyncio.run(two_lookups())
    assert len(fake_nominatim) == 2
    assert sleeps and 0 < sleeps[-1] <= 0.2
