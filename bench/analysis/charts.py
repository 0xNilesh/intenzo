"""IntentBench's charts (T6.4): the proof slide, from bench/results/judge-<split>.json.

  bench/analysis/.venv/bin/python bench/analysis/charts.py [results.json] [out dir]

Writes into bench/results/: rates.png (catch, false-fail and false-pass rates per arm, with the
range across repeats), accuracy.png (all and judgeable criteria) and cost.png (cost per PR).
"""

from __future__ import annotations

import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")  # files only, no window
import matplotlib.pyplot as plt

from metrics import load, summary

ARM_NAMES = {"A": "A · diff only", "B": "B · readings", "C": "C · frames", "D": "D · video"}


def _label(arm: str, judge: str) -> str:
    """Arms A–C have one judge; arm D shows the dual verdict and each model alone."""
    if arm != "D":
        return ARM_NAMES[arm]
    return f"{ARM_NAMES[arm]} ({'both judges' if judge == 'dual' else judge})"


def _err(spreads):
    """Matplotlib's asymmetric error bars from Spreads (zero where there's one repeat)."""
    lows = [0 if s is None else s.mean - s.low for s in spreads]
    highs = [0 if s is None else s.high - s.mean for s in spreads]
    return [lows, highs]


def _bars(ax, x, groups, width):
    """Grouped bars: one (label, spreads) group per series, with the range across repeats."""
    n = len(groups)
    for k, (label, spreads) in enumerate(groups):
        offset = (k - (n - 1) / 2) * width
        ax.bar([i + offset for i in x], [0 if s is None else s.mean for s in spreads], width,
               yerr=_err(spreads), capsize=3, label=label)


def render(results: str | Path, out: str | Path) -> list[Path]:
    table = summary(load(results))
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    labels = [_label(r.arm, r.judge) for r in table.itertuples()]
    x = list(range(len(labels)))
    pct = matplotlib.ticker.PercentFormatter(1.0)
    files = []

    fig, ax = plt.subplots(figsize=(11, 4.8))
    _bars(ax, x, [("catch rate (almost right)", list(table["catch_rate"])),
                  ("false-fail rate", list(table["false_fail_rate"])),
                  ("false-pass rate", list(table["false_pass_rate"]))], 0.27)
    ax.set_xticks(x, labels, rotation=20, ha="right")
    ax.set_ylim(0, 1.05)
    ax.yaxis.set_major_formatter(pct)
    ax.set_title("IntentBench, held out: failures caught vs. wrong verdicts (8 cases: small n)")
    ax.legend()
    fig.tight_layout()
    files.append(out / "rates.png")
    fig.savefig(files[-1], dpi=150)
    plt.close(fig)

    fig, ax = plt.subplots(figsize=(11, 4.8))
    _bars(ax, x, [("accuracy, all criteria", list(table["accuracy"])),
                  ("accuracy, judgeable criteria", list(table["judgeable_accuracy"]))], 0.38)
    ax.set_xticks(x, labels, rotation=20, ha="right")
    ax.set_ylim(0, 1.05)
    ax.yaxis.set_major_formatter(pct)
    ax.set_title("Accuracy by arm (judgeable: the pack could be recorded)")
    ax.legend(loc="lower right")
    fig.tight_layout()
    files.append(out / "accuracy.png")
    fig.savefig(files[-1], dpi=150)
    plt.close(fig)

    # Arm D's single-model rows carry no spend of their own (it's on the dual row).
    priced = table[(table["arm"] != "D") | (table["judge"] == "dual")]
    fig, ax = plt.subplots(figsize=(8, 4))
    cost = list(priced["usd_per_pr"])
    px = list(range(len(priced)))
    ax.bar(px, [0 if s is None else s.mean for s in cost], yerr=_err(cost), capsize=3, color="#6b7280")
    ax.set_xticks(px, [_label(r.arm, r.judge) for r in priced.itertuples()], rotation=20, ha="right")
    ax.set_ylabel("USD per PR (list price)")
    ax.set_title("Cost per PR by arm")
    fig.tight_layout()
    files.append(out / "cost.png")
    fig.savefig(files[-1], dpi=150)
    plt.close(fig)
    return files


if __name__ == "__main__":
    here = Path(__file__).parent
    results = sys.argv[1] if len(sys.argv) > 1 else here.parent / "results" / "judge-heldout.json"
    out = sys.argv[2] if len(sys.argv) > 2 else here.parent / "results"
    for f in render(results, out):
        print(f)
