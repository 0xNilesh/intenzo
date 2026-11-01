"""The charts render from a results file (T6.4)."""

from pathlib import Path

from charts import render

FIXTURE = Path(__file__).parent / "fixture.json"


def test_renders_the_charts(tmp_path):
    files = render(FIXTURE, tmp_path)
    assert [f.name for f in files] == ["rates.png", "accuracy.png", "cost.png"]
    for f in files:
        assert f.read_bytes()[:8] == b"\x89PNG\r\n\x1a\n"
