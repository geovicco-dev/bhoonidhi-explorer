"""Run the scenarios against the real model and the real catalogue, and print
a scorecard.

    cd apps/api
    uv run python -m scenarios                 # the scenarios this slice covers
    uv run python -m scenarios --all           # every scenario, screen ones as "no check"
    uv run python -m scenarios --group when    # one group
    uv run python -m scenarios --id when-may-ten-years
    uv run python -m scenarios --list          # what exists, nothing run

The agent runs in this process, so the API on :8787 is untouched and no
conversation is stored. Each run is written to scenarios/results/<stamp>.json
and the newest is compared with the previous one, so a slice's effect shows as
fixed and broken counts.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from bhoonidhi_api import agent, tools
from bhoonidhi_api.config import settings

from . import cases, checks

RESULTS = Path(__file__).parent / "results"


async def run_one(scenario: cases.Scenario) -> checks.Run:
    """Every prompt of a scenario as one conversation, the later prompts seeing
    the earlier turns exactly as the API would replay them."""
    run = checks.Run()
    history: list[dict[str, Any]] = []
    for prompt in scenario.prompts:
        turn = checks.TurnRun(prompt=prompt)
        started = time.monotonic()
        produced: list[dict[str, Any]] = []
        async for event in agent.run_agent(prompt, history, scenario.area):
            if event["type"] == "turn_llm":
                produced = event["messages"]
            else:
                turn.events.append(event)
        turn.seconds = time.monotonic() - started
        history = [*history, {"role": "user", "content": prompt}, *produced]
        run.turns.append(turn)
    return run


def verdict(scenario: cases.Scenario, run: checks.Run) -> tuple[str, list[str]]:
    if scenario.screen or not scenario.checks:
        return "no check", []
    failures = [why for check in scenario.checks if (why := check(run)) is not None]
    return ("pass" if not failures else "fail"), failures


def summarise(run: checks.Run) -> dict[str, Any]:
    """The few numbers worth keeping from a run, for the saved result."""
    last = run.last
    return {
        "seconds": round(run.seconds, 1),
        "tools": [t.calls for t in run.turns],
        "searched": [s.result.get("searched") for s in last.searches],
        "count": [s.result.get("count") for s in last.searches],
        "scenes": len(run.scenes),
        "answer": last.answer.replace("\n", " ")[:400],
        "error": last.error[:200],
    }


def previous() -> dict[str, str]:
    """The last verdict recorded for each scenario, across every saved run.

    A full run takes about fifteen minutes, so the set is usually run one group
    at a time. Reading only the newest file would leave every scenario outside
    that group with nothing to compare against.
    """
    seen: dict[str, str] = {}
    for path in sorted(RESULTS.glob("*.json")):
        data = json.loads(path.read_text())
        for row in data["scenarios"]:
            seen[row["id"]] = row["verdict"]
    return seen


async def main() -> int:
    parser = argparse.ArgumentParser(description="Run the explorer's usage scenarios.")
    parser.add_argument("--all", action="store_true", help="include the scenarios waiting for a later slice")
    parser.add_argument("--group", action="append", help="only this group (repeatable)")
    parser.add_argument("--id", action="append", help="only this scenario (repeatable)")
    parser.add_argument("--list", action="store_true", help="list the scenarios and exit")
    args = parser.parse_args()

    chosen = cases.selected(args.group, args.id, args.all)
    if args.list:
        for s in cases.SCENARIOS:
            state = "screen" if s.screen else "later" if s.later else "now"
            print(f"  {state:6s} {s.group:16s} {s.id:26s} {s.about}")
        print(f"\n{len(cases.SCENARIOS)} scenarios; {len(cases.selected())} run by default.")
        return 0
    if not chosen:
        print("nothing matched")
        return 2

    checks.CATALOGUE = await tools.catalogue()
    was = previous()
    print(f"model {settings.openai_model}, catalogue {settings.stac_api_url}, {len(chosen)} scenarios\n", flush=True)

    rows = []
    for n, scenario in enumerate(chosen, 1):
        try:
            run = await run_one(scenario)
        except Exception as exc:  # noqa: BLE001 - a broken scenario must not stop the run
            rows.append({"id": scenario.id, "group": scenario.group, "verdict": "fail",
                         "failures": [f"{type(exc).__name__}: {exc}"], "about": scenario.about, "run": {}})
            print(f"  [{n}/{len(chosen)}] fail    {scenario.id}: {type(exc).__name__}: {exc}", flush=True)
            continue
        state, failures = verdict(scenario, run)
        moved = ""
        if scenario.id in was and was[scenario.id] != state:
            moved = f"  ({was[scenario.id]} -> {state})"
        rows.append({"id": scenario.id, "group": scenario.group, "verdict": state,
                     "failures": failures, "about": scenario.about, "run": summarise(run)})
        print(f"  [{n}/{len(chosen)}] {state:7s} {scenario.id:26s} {run.seconds:5.0f}s{moved}", flush=True)
        for why in failures:
            print(f"            - {why}", flush=True)

    tally: dict[str, int] = {}
    for r in rows:
        tally[r["verdict"]] = tally.get(r["verdict"], 0) + 1
    fixed = [r["id"] for r in rows if was.get(r["id"]) == "fail" and r["verdict"] == "pass"]
    broken = [r["id"] for r in rows if was.get(r["id"]) == "pass" and r["verdict"] == "fail"]

    RESULTS.mkdir(exist_ok=True)
    stamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
    path = RESULTS / f"{stamp}.json"
    path.write_text(json.dumps({
        "at": stamp, "model": settings.openai_model, "scenarios": rows,
        "tally": tally, "fixed": fixed, "broken": broken,
    }, indent=2, default=str))

    print(f"\n{tally}")
    if fixed:
        print("fixed:  " + ", ".join(fixed))
    if broken:
        print("broken: " + ", ".join(broken))
    print(f"saved {path}")
    return 1 if broken else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
