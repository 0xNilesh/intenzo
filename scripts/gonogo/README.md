# Judge go/no-go (ROADMAP T0.3)

Before any pipeline code depends on it, this checks that the judging design actually works. Two
Meta models watch short UI clips with a known right answer and judge one acceptance criterion
each, under the agreement rule from ARCHITECTURE §22.3. The output is a GO / NO-GO decision
against the roadmap thresholds.

## Run

```bash
pnpm gonogo --dry-run       # record the clips and write every judge bundle; no model calls
pnpm gonogo                 # judge every clip that isn't cached, then score and decide
pnpm gonogo --effort=low    # the same with reasoning_effort=low on both judges (cached separately)
pnpm gonogo --only=total-stale,expired-missing   # a few clips (a partial run is not a decision)
pnpm gonogo --rejudge       # ask again even if an answer is cached (billed)
pnpm gonogo --rerecord      # record every clip again (new clips mean new, billed calls)
```

- **Keys** come from `.env` (see `.env.example`): `META_API_KEY` for Spark 1.3, and `BASETEN_API_KEY`
  (or `SPARK_OPEN_BASE_URL` + `SPARK_OPEN_API_KEY`) for Spark Open. The run stops before calling
  anything if a key it needs is missing.
- **Cost:** a full run is 20 judge calls (10 clips × 2 judges), about $0.01 each, so roughly
  $0.10–0.20. The run prints how many calls it needs before making any, and the actual spend at
  the end. Answers are cached by a hash of the exact request (prompt, media, model, effort), so a
  re-run only pays for what changed. It stops at 60 HTTP requests whatever happens.
- **Needs:** ffmpeg (any build: text is drawn by Chromium, not `drawtext`), and Playwright's
  Chromium (`pnpm --filter @intenzo/core exec playwright install chromium`).
- **Output** goes to `probes/gonogo/` (gitignored): per clip `raw.webm`, `judge.mp4`, `shot.png`,
  `annotated.png`, `lane.json` (step log + readings) and `bundle.txt`; each answer in
  `judgements/`; everything in `results.json` (`results-<effort>.json` with `--effort`).

## The clips

`fixture/shop.html` is a small cart page. A `?variant=` query plants one behavior, and
`fixture/shop.browser.test.ts` proves each one, so every label is a tested fact. `clips.ts`
pairs a variant with a criterion:

| Clip                     | Truth     | Variant: what happens after Apply                                              |
| ------------------------ | --------- | ------------------------------------------------------------------------------ |
| `line-correct`           | pass      | correct: the discount line shows −$5.00                                        |
| `total-correct`          | pass      | correct: the total reads $45.00 at once and after a reload                     |
| `expired-correct`        | pass      | correct: OLD5 shows "This code has expired"                                    |
| `line-on-stale-build`    | pass      | stale-total: the total is buggy, but the criterion is only about the line      |
| `total-stale`            | fail      | stale-total: the total stays $50.00 until a reload                             |
| `total-off-by-cent`      | fail      | off-by-cent: the total reads $45.01                                            |
| `discount-wrong-percent` | fail      | wrong-percent: 15% off (−$7.50, $42.50)                                        |
| `expired-missing`        | fail      | missing-error: OLD5 shows nothing                                              |
| `confirm-quiet`          | ambiguous | quiet-confirm: no message, only a grey "Applied" button. "Clear confirmation"? |
| `total-slow`             | ambiguous | slow-total: "Updating…" for 2 s. "Quickly"?                                    |

Ambiguous clips have no right answer. They're reported (the agreement rule should ideally make
them inconclusive) but don't count toward the GO thresholds.

## How a clip is recorded and judged

1. `lib/record.ts` runs a cut-down §21.3 observation protocol: open `/cart`, fill the code, read
   PRE, click Apply (Tt), read POST at Tt+0/+1000/+3000 (+ `timingMs`), screenshot at Tt+1000,
   and reload for `after_reload` readings when the criterion needs persistence. Readings are
   watched elements (text + bbox, or `absent`) and the page's live regions, diffed against PRE
   (`+ alert: This code has expired`, or `no change`).
2. `lib/encode.ts` makes the judge clip (960×540 at 4 fps, H.264, §14) with the lane time in a
   black band _under_ each frame, and boxes the watched elements on the Tt+1000 screenshot with
   their labels in a column _beside_ it. Nothing drawn covers the page.
3. `lib/prompt.ts` is the `judge.v1` draft: the §22.2 rules and bundle (criterion, step log with
   the TRIGGER, the readings table, counts), with ticket and page text in `<untrusted>` blocks.
4. `lib/judge.ts` asks judge A (Spark Open on Baseten, `meta-models/muse-spark-open`) and judge B
   (Spark 1.3) in parallel. Spark 1.3 gets a strict `json_schema`; Baseten's Spark Open has no
   structured outputs, so it's asked by prompt and its reply is checked against `JudgeOutput`
   (one retry with the error, §14).
5. `lib/combine.ts` applies §22.3: a wrong target, or a pass or fail whose `citedValue` doesn't
   match its cited readings (`valueMatches`, by tokens), makes that judge inconclusive; the final
   verdict is pass or fail only when both judges say it.
6. `lib/score.ts` scores it: GO needs accuracy ≥ 80% on decided clips, 0 false fails on correct
   clips, inconclusive ≤ 30% on clear clips, and every verdict under 60 s. Each judge alone and
   the R13 fallback (§34) are scored from the same answers, at no extra cost.

## Known simplifications (P0 tooling, not the production pipeline)

- **One take, no base lane:** no §19e re-record and no baseline comparison. The bundle says
  "Baseline: none".
- **Clock:** lane time starts when the page and its video start. A green-marker check put the
  video clock within about 50–80 ms of it. T1.4 builds marker alignment.
- **Settle** is a fixed 300 ms, enough for this static page. T1.6 builds the real `settle()`.
- **Schemas** in `lib/schema.ts` are cut-down §7 drafts. T1.1 builds the real ones in `core`.
