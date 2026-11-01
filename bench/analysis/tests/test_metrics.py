"""T6.4's metric functions on a results file small enough to check by hand (tests/fixture.json).

Repeat 1: x/C1 (fail) judged fail, x/C2 (pass) judged pass, y/C1 (pass) judged inconclusive.
Repeat 2: x/C1 judged pass (missed), x/C2 judged fail (a false fail), y/C1 judged pass.
"""

from pathlib import Path

import pytest

from metrics import load, markdown, per_repeat, summary

FIXTURE = Path(__file__).parent / "fixture.json"


@pytest.fixture
def rows():
    return load(FIXTURE)


def test_per_repeat_by_hand(rows):
    r1, r2 = per_repeat(rows).sort_values("repeat").to_dict("records")
    assert r1["accuracy"] == pytest.approx(2 / 3)
    assert r1["catch_rate"] == 1.0
    assert r1["false_fail_rate"] == 0.0
    assert r1["inconclusive_rate"] == pytest.approx(1 / 3)
    assert r1["usd_per_pr"] == pytest.approx((0.02 + 0.01) / 2)  # case x is 2 criteria, y is 1
    assert r1["seconds_per_pr"] == pytest.approx(2.5)
    assert r2["accuracy"] == pytest.approx(1 / 3)
    assert r2["catch_rate"] == 0.0
    assert r2["false_fail_rate"] == pytest.approx(0.5)
    assert r2["inconclusive_rate"] == 0.0
    assert r2["usd_per_pr"] == pytest.approx(0.03)
    assert r2["seconds_per_pr"] == pytest.approx(1.5)


def test_summary_is_the_mean_and_range_across_repeats(rows):
    (line,) = summary(rows).to_dict("records")
    assert (line["arm"], line["judge"], line["repeats"], line["criteria"]) == ("B", "spark-1.3", 2, 3)
    acc = line["accuracy"]
    assert (acc.mean, acc.low, acc.high) == pytest.approx((0.5, 1 / 3, 2 / 3))
    assert line["catch_rate"].mean == pytest.approx(0.5)
    assert line["false_fail_rate"].mean == pytest.approx(0.25)
    assert line["usd_per_pr"].mean == pytest.approx(0.0225)
    assert line["seconds_per_pr"].mean == pytest.approx(2.0)


def test_an_inconclusive_verdict_is_never_right(rows):
    only_unsure = rows[rows["verdict"] == "inconclusive"]
    assert per_repeat(only_unsure)["accuracy"].tolist() == [0.0]


def test_a_rate_with_nothing_to_count_is_left_out(rows):
    correct_only = rows[rows["kind"] == "correct"]  # no almost-right failures to catch
    (line,) = summary(correct_only).to_dict("records")
    assert line["catch_rate"] is None


def test_markdown_table(rows):
    table = markdown(summary(rows))
    assert table.splitlines()[0].startswith("| Arm | Judge | Accuracy | Judgeable accuracy |")
    assert (
        "| B | spark-1.3 | 50% (33%–67%) | 50% (33%–67%) | 50% (0%–100%) | 25% (0%–50%) | "
        "50% (0%–100%) | 17% (0%–33%) | $0.022 | 2 s |"
    ) in table


def _row(**over):
    base = dict(arm="A", judge="spark-1.3", caseId="b", criterionId="C1", kind="broken", split="heldout",
                label="fail", repeat=1, verdict="pass", reason="agreed", rerecorded=False, calls=1, usd=0.01,
                ms=1000, pack="p")
    return {**base, **over}


def test_false_passes_and_judgeable_accuracy_on_a_broken_build():
    """A diff-only arm passes a broken build that the browser arms can't record (setup_failed)."""
    import pandas as pd

    rows = pd.DataFrame(
        [
            _row(arm="A", verdict="pass"),  # a wrong pass, from the diff
            _row(arm="B", verdict="inconclusive", reason="setup_failed", calls=0, usd=0),
            _row(arm="A", caseId="ok", criterionId="C1", kind="correct", label="pass", verdict="pass"),
            _row(arm="B", caseId="ok", criterionId="C1", kind="correct", label="pass", verdict="pass"),
        ]
    )
    a, b = per_repeat(rows).sort_values("arm").to_dict("records")
    assert a["false_pass_rate"] == 1.0 and b["false_pass_rate"] == 0.0
    assert a["accuracy"] == 0.5 and b["accuracy"] == 0.5
    # Without the unjudgeable broken pack, both arms got the one judgeable criterion right.
    assert a["judgeable_accuracy"] == 1.0 and b["judgeable_accuracy"] == 1.0


def test_arm_d_single_models_show_their_cost_in_the_dual_row():
    import pandas as pd

    rows = pd.DataFrame([_row(arm="D", judge="dual", usd=0.04), _row(arm="D", judge="spark-open", usd=0, calls=0)])
    table = markdown(summary(rows))
    assert "| D | dual |" in table and "$0.040" in table
    assert "| D | spark-open |" in table and "| in dual | in dual |" in table
