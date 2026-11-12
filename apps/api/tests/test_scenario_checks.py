"""The scenario checks, on answers and searches models really gave (Nov 2026
runs) and on the right answers the tool now makes possible."""
from __future__ import annotations

import pytest

from scenarios.checks import _searched_near, start_year_said


@pytest.mark.parametrize("answer", [
    # Gemma, 5 of 5 runs.
    "LISS-3 imagery for Punjab goes back to 1997, based on the availability of the IRS-1C satellite.",
    # What the oldest-match lookup lets a model say, in the tool's own date form.
    "LISS-3 over Punjab goes back to 03-Jan-1997. The oldest scene that matches is from 03-Jan-1997.",
    # The window may be mentioned too, after the start.
    "The archive goes back to January 1997. Only the newest 1,000 are shown, back to June 2025.",
    "LISS-3 scenes over Punjab have been collected since **1997**.",
])
def test_an_answer_that_leads_with_the_real_start_passes(answer):
    assert start_year_said(answer, "1997") is None


@pytest.mark.parametrize(("answer", "why"), [
    # Haiku 5.5: the year appears, but denied. The old check passed these.
    ("Over Punjab, the catalogue's LISS-3 holdings start in June 2025, not 1997. "
     "The search covered 1997-01-01 to 2026-11-11.", "do not go back to 1997"),
    ("Over Punjab, the catalogue's LISS-3 holdings start on 13 June 2025, not in 1997.", "do not go back to 1997"),
    # Haiku 5.5: a later start, with 1997 elsewhere. The old check passed this.
    ("**Short answer:** LISS-3 over Punjab goes back to at least **February 2006** in the catalogue. "
     "The 1997-2005 IRS-1C/1D scenes that the catalogue lists for LISS-3 did not appear.", "start as 2006"),
    ("LISS-3 imagery over Punjab in the catalogue goes back only to **13 June 2025**, not to 1990. "
     "I searched 1990 to today.", "start as 2025"),
    # A satellite's own start year later on does not rescue a wrong start.
    ("Over Punjab the scenes start in June 2025. IRS-1C began in 1997.", "start as 2025"),
    # The search window is not the archive's start.
    ("I searched from 1997 to today, and the earliest scene is from 13 June 2025.", "start as 2025"),
    ("There are over 1,000 LISS-3 scenes over Punjab.", "no year"),
])
def test_an_answer_that_gives_another_start_fails(answer, why):
    verdict = start_year_said(answer, "1997")
    assert verdict is not None and why in verdict


DELHI_POINT = (77.209, 28.6139)


@pytest.mark.parametrize(("args", "covered"), [
    # Haiku, 12 Nov: a 30 km circle centred 5.8 km from the point.
    ({"lat": 28.6664535, "lon": 77.2169781, "radius_km": 30}, True),
    # Gemma: the place's box from resolve_location.
    ({"minx": 76.8388351, "miny": 28.4046285, "maxx": 77.3453379, "maxy": 28.8834464}, True),
    # Haiku with strict tools: no area at all, so all of India.
    ({"start_date": "2026-08-01", "end_date": "2026-08-31", "satellite": "Sentinel-2"}, False),
    # A circle over Agra does not cover Delhi.
    ({"lat": 27.1767, "lon": 78.0081, "radius_km": 30}, False),
])
def test_a_search_covers_the_named_place_only_when_its_area_holds_it(args, covered):
    assert _searched_near(args, *DELHI_POINT) is covered
