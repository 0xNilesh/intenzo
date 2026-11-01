"""IntentBench's metrics (ARCHITECTURE §31, T6.4).

Reads the results T6.3's `pnpm bench:judge` writes (bench/results/judge-<split>.json) and computes,
for each arm and judge, per repeat and then as mean ± spread across repeats:

- accuracy: verdicts equal to the label (an inconclusive verdict is never right)
- catch rate: on almost-right cases, the share of truly failing criteria judged "fail"
- false-fail rate: the share of truly passing criteria judged "fail"
- inconclusive rate: the share of criteria judged "inconclusive"
- false-pass rate: the share of truly failing criteria judged "pass" (any kind of case): the
  error that would let a bad PR merge
- judgeable accuracy: accuracy without the criteria whose pack is setup_failed, which no browser
  arm can judge but the diff-only arm can
- cost per PR and time per PR: a case is one PR; its criteria's spend and time, summed

Side-effect detection isn't in these results: the packs hold no route snapshots (T6.2's handover),
so it's reported as not measured rather than guessed.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import pandas as pd

METRICS = [
    "accuracy",
    "judgeable_accuracy",
    "catch_rate",
    "false_fail_rate",
    "false_pass_rate",
    "inconclusive_rate",
    "usd_per_pr",
    "seconds_per_pr",
]


def load(path: str | Path) -> pd.DataFrame:
    """The results file's rows as a DataFrame."""
    data = json.loads(Path(path).read_text())
    return pd.DataFrame(data["rows"])


def _share(hits: pd.Series, of: pd.Series) -> float:
    """hits / of, or NaN when there's nothing to count."""
    n = int(of.sum())
    return float(hits.sum()) / n if n else float("nan")


def unjudgeable(rows: pd.DataFrame) -> set[tuple[str, str]]:
    """The (case, criterion) pairs whose pack is setup_failed: no recording to judge."""
    failed = rows[rows["reason"] == "setup_failed"]
    return set(zip(failed["caseId"], failed["criterionId"]))


def per_repeat(rows: pd.DataFrame) -> pd.DataFrame:
    """One line per arm, judge and repeat, with every metric."""
    skip = unjudgeable(rows)
    out = []
    for (arm, judge, repeat), g in rows.groupby(["arm", "judge", "repeat"], sort=True):
        right = g["verdict"] == g["label"]
        failing = (g["label"] == "fail") & (g["kind"] == "almost_right")
        passing = g["label"] == "pass"
        per_pr = g.groupby("caseId")[["usd", "ms"]].sum()
        judgeable = pd.Series([(c, k) not in skip for c, k in zip(g["caseId"], g["criterionId"])], index=g.index)
        failing_any = g["label"] == "fail"
        out.append(
            {
                "arm": arm,
                "judge": judge,
                "repeat": repeat,
                "criteria": len(g),
                "accuracy": _share(right, pd.Series([True] * len(g))),
                "judgeable_accuracy": _share(right & judgeable, judgeable),
                "catch_rate": _share(failing & (g["verdict"] == "fail"), failing),
                "false_fail_rate": _share(passing & (g["verdict"] == "fail"), passing),
                "false_pass_rate": _share(failing_any & (g["verdict"] == "pass"), failing_any),
                "inconclusive_rate": _share(g["verdict"] == "inconclusive", pd.Series([True] * len(g))),
                "usd_per_pr": float(per_pr["usd"].mean()),
                "seconds_per_pr": float(per_pr["ms"].mean()) / 1000,
            }
        )
    return pd.DataFrame(out)


@dataclass(frozen=True)
class Spread:
    mean: float
    low: float
    high: float
    repeats: int

    def __str__(self) -> str:
        if self.repeats == 1:
            return f"{self.mean:.2f}"
        return f"{self.mean:.2f} ({self.low:.2f}–{self.high:.2f})"


def summary(rows: pd.DataFrame) -> pd.DataFrame:
    """Mean and range across repeats, per arm and judge: the table the README and charts use."""
    reps = per_repeat(rows)
    lines = []
    for (arm, judge), g in reps.groupby(["arm", "judge"], sort=True):
        line: dict[str, object] = {"arm": arm, "judge": judge, "repeats": len(g), "criteria": int(g["criteria"].iloc[0])}
        for m in METRICS:
            values = g[m].dropna()
            line[m] = Spread(float(values.mean()), float(values.min()), float(values.max()), len(values)) if len(values) else None
        lines.append(line)
    return pd.DataFrame(lines)


def markdown(table: pd.DataFrame) -> str:
    """The summary as a Markdown table, rates as percentages."""

    def pct(s: Spread | None) -> str:
        if s is None:
            return "—"
        return f"{s.mean:.0%}" if s.repeats == 1 or s.low == s.high else f"{s.mean:.0%} ({s.low:.0%}–{s.high:.0%})"

    def money(s: Spread | None, arm: str, judge: str) -> str:
        # Arm D's single-model rows share the dual row's calls, which carry the spend.
        if arm == "D" and judge != "dual":
            return "in dual"
        return "—" if s is None else f"${s.mean:.3f}"

    def secs(s: Spread | None, arm: str, judge: str) -> str:
        if arm == "D" and judge != "dual":
            return "in dual"
        return "—" if s is None else f"{s.mean:.0f} s"

    head = (
        "| Arm | Judge | Accuracy | Judgeable accuracy | Catch rate (almost right) | False fails | "
        "False passes | Inconclusive | Cost / PR | Time / PR |"
    )
    rule = "|---|---|---|---|---|---|---|---|---|---|"
    body = [
        f"| {r.arm} | {r.judge} | {pct(r.accuracy)} | {pct(r.judgeable_accuracy)} | {pct(r.catch_rate)} | "
        f"{pct(r.false_fail_rate)} | {pct(r.false_pass_rate)} | {pct(r.inconclusive_rate)} | "
        f"{money(r.usd_per_pr, r.arm, r.judge)} | {secs(r.seconds_per_pr, r.arm, r.judge)} |"
        for r in table.itertuples()
    ]
    return "\n".join([head, rule, *body])


if __name__ == "__main__":
    import sys

    results = sys.argv[1] if len(sys.argv) > 1 else str(Path(__file__).parents[1] / "results" / "judge-heldout.json")
    print(markdown(summary(load(results))))
