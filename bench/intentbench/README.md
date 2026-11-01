# @intenzo/intentbench

IntentBench (ARCHITECTURE §31): record once, judge many. Twelve demo-shop branches implement four
tickets correctly, almost right, with an unrequested side effect, or broken. Every criterion has a
ground-truth label that a deterministic Playwright check proves on the branch's preview.

## Tickets

`tickets/<name>.md` is the ticket as written (what Muse Code implemented, and what the diff-only
arm will read); `tickets/<name>.criteria.json` holds its criteria in core's `Criterion` shape, the
same for every case and every arm.

| Ticket                                            | Criteria                                                                                                                                                                     |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `discount`: discount codes (demo-shop #5 as text) | C1 the "Discount (SAVE10)" line · C2 the total at $45.00 within 1 s · C3 OLD5 "This code has expired" · C4 the chart's discount slice                                        |
| `shipping`: free shipping progress                | C1 shipping $5.00 in a $55.00 total · C2 "Add $25.00 more for free shipping" · C3 at $75.00 "You've got free shipping!" and Shipping Free · C4 at $75.00 the total is $75.00 |
| `limit`: 5 per item                               | C1 "+" disabled at 5 · C2 "Limit 5 per item" · C3 Products refuses a sixth                                                                                                   |
| `undo`: undo Remove                               | C1 "Removed Ceramic mug" with Undo · C2 Undo restores the quantity · C3 Undo restores the totals                                                                             |

## Cases

`cases/<id>.json`, one per demo-shop branch `bench/<id>`, checked by `BenchCase` (`src/case.ts`).

| Case                    | Kind                  | Split    | Fails  | How it was made                          |
| ----------------------- | --------------------- | -------- | ------ | ---------------------------------------- |
| discount-correct        | correct               | held out | none   | Muse Code, unedited                      |
| shipping-correct        | correct               | held out | none   | Muse Code, unedited                      |
| limit-correct           | correct               | tuning   | none   | Muse Code, unedited                      |
| undo-correct            | correct               | held out | none   | Muse Code, unedited                      |
| discount-almost-right   | almost right (seeded) | held out | C2     | the total memoised on the lines only     |
| discount-almost-right-2 | almost right (seeded) | held out | C3     | "This code is not valid"                 |
| shipping-almost-right   | almost right (seeded) | tuning   | C3, C4 | `>` instead of `>=` at $75.00            |
| limit-almost-right      | almost right (seeded) | held out | C1     | "+" disabled only above the limit        |
| undo-almost-right       | almost right (seeded) | tuning   | C2, C3 | Undo restores quantity 1                 |
| shipping-side-effect    | side effect           | tuning   | none   | also renames "Checkout" to "Place order" |
| undo-side-effect        | side effect           | held out | none   | also drops the header's cart count       |
| limit-broken            | broken                | held out | all    | the cart page throws on every load       |

42 labelled criteria. Only held-out results are reported (§31), with the small-n caveat.

## Validate

```bash
pnpm bench:validate [--only=<case id prefix>]
```

It checks the case files and §31's split, then on each branch's Vercel preview runs every
criterion's check with a fresh shopper, and each side-effect check. Every observation must match
its label. It needs `gh` and demo-shop's `DEMO_SHOP_HOOK_SECRET` and `DEMO_SHOP_BYPASS_SECRET` in
`.env`. It makes no model calls and takes about 3 minutes.

## Record

```bash
pnpm bench:record [--only=<case id prefix>] [--concurrency=<n>]
```

Phase 1 of §31, "record once". For each criterion of each case, Wonder explores the case's preview
once, as the worker does (§20.3). The recorder then follows the path it found: two PR takes on the
case's preview (for §19 step e's re-record rule) and one base take on the preview of `main` at
`83d338a`, where every bench branch starts. Each criterion's pack goes in
`packs/<case>/<criterion>/` (gitignored, since it holds the videos):

| File                      | What                                                                  |
| ------------------------- | --------------------------------------------------------------------- |
| `pack.json`               | `Pack` (`src/pack.ts`): the exploration, the path, each take's lane   |
| `pr-1/`, `pr-2/`, `base/` | `judge.mp4`, `human.mp4`, `shot-annotated.png` (§21.3–21.4)           |
| `packs/<case>/diff.json`  | the branch's diff since `83d338a`, in the context bundle's shape (§8) |

- **A failed exploration is kept:** its pack says `setup_failed` or `trigger_absent` and has no
  takes, so the case's row reports it (§31).
- **A crash leaves no pack,** so running again records only what's missing. Packs that exist are
  never re-recorded; delete a pack's folder to record it again.
- **Secrets are redacted** from every pack and log line. A take keeps no raw video or trace, since a
  trace holds the request headers, the bypass among them.
- **`manifest.json` is committed:** a row per pack with its statuses and a sha256 over its files, so
  results can name the exact evidence they judged.

It needs `gh`, `META_API_KEY` and demo-shop's `DEMO_SHOP_HOOK_SECRET` and `DEMO_SHOP_BYPASS_SECRET`
in `.env`.

## Cost

- **The four correct implementations:** Muse Code in contributor mode, about $0.05 in all (2–4.5 min
  each).
- **Validation:** free.
- **Recording:** only the exploring costs, in Wonder calls.
  - A criterion it finds costs about $0.03 (1–12 calls).
  - One it can't find costs $0.13–0.26, until its 25 steps or 120 s run out.
  - The takes are free.
  - The 42 packs cost $1.78. T6.2 spent $2.79 in all, counting the smoke run and the 11 packs re-recorded after demo-shop allowed "remove" (DECISIONS 2026-11-01).

## Recorded (2026-11-01)

`manifest.json` lists every pack.

| Outcome                                      | Criteria | Where                                                                                                                           |
| -------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Explored; both PR takes completed            | 37       | every criterion but the five below                                                                                              |
| `setup_failed`, as the case intends          | 3        | limit-broken: its cart throws on every load                                                                                     |
| `setup_failed`, the navigator lost its way   | 2        | undo-side-effect C2 and C3: "Undo" went stale after Remove, then 20 steps between `/products` and `/cart` with no "Add to cart" |
| Base take `trigger_absent` or `setup_failed` | 16       | the base has no discount code field (all 12 discount criteria) or no Undo (4 undo criteria): the base's own state, as expected  |

- **Time:** 39 packs took 13.9 min at concurrency 2, and the 11 re-recorded ones 5.6 min. The packs take 18 MB.
- **The judge video starts at the trigger:** its first frame is within 50 ms of the first trigger step. A trigger's clicks are about 30 ms apart, so the state between them (the mug at 2 before Remove) is only in the step log and the criterion.

## Judge

```bash
pnpm bench:judge [--split heldout|tuning] [--arms A,B,C,D] [--repeats 3] [--only <case>[/<C>]]
                 [--dry-run] [--fresh] [--max-usd 6] [--max-open-usd 0.6]
```

Phase 2 of §31, "judge many". Every arm judges every criterion of the split from its pack, three
times by default:

| Arm         | What the judges get                                                                                           | Judges                                 |
| ----------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| A diff-only | the ticket, the case's diff since `83d338a` and the criterion (`review.v1`, `src/review.ts`); no browser data | Spark 1.3                              |
| B readings  | judge.v1's text: the step log, the readings and the baseline's; no images, and a note saying so               | Spark 1.3                              |
| C frames    | B, the annotated still, and each judge video as stills at 2 fps (every other frame, its time band kept)       | Spark 1.3                              |
| D video     | the worker's own bundle (§22.2): the annotated still and the judge videos                                     | Spark Open + Spark 1.3, and each alone |

- **The worker's rules:** §22.1 before any judge looks, §22.3's checks on each answer, and §19 e on
  the pack's two PR takes: a fail or a tie on `pr-1` is judged once more on `pr-2`. A judge is asked
  on `pr-2` only when a verdict needs it. B, C and D send judge.v1 through core's `judgeRequest()`,
  so they differ from production only in the media.
- **A pack without takes** (`setup_failed`) is inconclusive for B–D without a call; A still reviews
  its diff.
- **One judge alone** answers `decided` (it passed or failed) or `unsure` (it said inconclusive),
  and its fail is confirmed on `pr-2` or becomes `flaky`, like the dual verdict.
- **The evidence is checked:** every pack must match `manifest.json`'s sha256 before it's judged.
- **Results:** `bench/results/judge-<split>.json`, written after each criterion: `verdicts`, one
  per arm, repeat, criterion and view, and `calls`, one per model call with its tokens, cost, time
  and the judge's answer. Flat lists, so pandas reads them as tables (T6.4). A rerun judges only
  what's missing, `--fresh` starts over, and a changed arm prompt refuses to mix with old rows.
  `--only` runs go to `bench/results/raw/`, which isn't committed, and so do arm C's stills.
- **Caps:** no new criterion starts once the calls cost `--max-usd`, or Spark Open's cost
  `--max-open-usd` (Baseten credit).

It needs `META_API_KEY`, and `BASETEN_API_KEY` for arm D, in `.env`, the packs, and ffmpeg for arm
C.

## Tests

```bash
pnpm --filter @intenzo/intentbench test   # cases, split, packs, reruns; the arms, §19 e, results
```
