"""Read every saved scenario run and print the current scorecard.

    cd apps/api
    uv run python -m scenarios.scorecard

The set is normally run one group at a time, so no single result file holds
every scenario. This reads them all, keeps the newest verdict per scenario, and
prints one table plus the failure reasons.
"""
from __future__ import annotations

import json
from pathlib import Path

from . import cases

RESULTS = Path(__file__).parent / "results"


def latest() -> dict[str, dict]:
    seen: dict[str, dict] = {}
    for path in sorted(RESULTS.glob("*.json")):
        data = json.loads(path.read_text())
        for row in data["scenarios"]:
            seen[row["id"]] = {**row, "at": data["at"], "model": data.get("model", "")}
    return seen


def main() -> int:
    runs = latest()
    if not runs:
        print("no runs saved yet")
        return 2

    by_group: dict[str, list[tuple[cases.Scenario, dict | None]]] = {}
    for scenario in cases.SCENARIOS:
        by_group.setdefault(scenario.group, []).append((scenario, runs.get(scenario.id)))

    tally: dict[str, int] = {}
    for group, rows in by_group.items():
        print(f"\n{group}")
        for scenario, row in rows:
            if row is None:
                state = "screen" if scenario.screen else "not run"
            else:
                state = row["verdict"]
            tally[state] = tally.get(state, 0) + 1
            print(f"  {state:8s} {scenario.id:26s} {scenario.about}")
            for why in (row or {}).get("failures", []):
                print(f"           - {why}")

    print("\n" + ", ".join(f"{n} {state}" for state, n in sorted(tally.items())))
    ran = [r for r in runs.values() if r["verdict"] in ("pass", "fail")]
    if ran:
        passed = sum(1 for r in ran if r["verdict"] == "pass")
        print(f"{passed}/{len(ran)} of the scenarios that have a check are passing")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
