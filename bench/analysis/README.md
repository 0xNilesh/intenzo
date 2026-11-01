# IntentBench analysis (T6.4)

The metrics and charts for the results of `pnpm bench:judge` (`bench/results/judge-<split>.json`).
Python with pandas and matplotlib, in a venv of its own:

```bash
python3 -m venv bench/analysis/.venv
bench/analysis/.venv/bin/pip install -r bench/analysis/requirements.txt
pnpm bench:analyze        # the Markdown table, then bench/results/{rates,accuracy,cost}.png
pnpm test:analysis        # pytest on a hand-computed results file (CI runs it too)
```

## Metrics

Each is computed per arm, judge and repeat, then reported as mean (low–high) across repeats.

| Metric               | What it counts                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Accuracy             | verdicts equal to the label; an inconclusive verdict is never right                                                       |
| Judgeable accuracy   | the same, without criteria whose pack is `setup_failed`: no browser arm can judge those, but the diff-only arm can        |
| Catch rate           | on almost-right cases, the truly failing criteria judged `fail` (§31)                                                     |
| False fails          | truly passing criteria judged `fail`                                                                                      |
| False passes         | truly failing criteria judged `pass`, in any kind of case: the error that lets a bad PR merge                             |
| Inconclusive         | criteria judged `inconclusive`                                                                                            |
| Cost / PR, time / PR | a case is one PR; its criteria's spend and time, summed. Arm D's single-model rows share the dual row's calls ("in dual") |

Side-effect detection isn't measured: the packs hold no route snapshots.

No model calls; nothing here costs anything.
