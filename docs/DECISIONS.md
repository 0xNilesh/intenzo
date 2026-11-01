# Decisions

Choices made while building Intenzo, with the evidence behind them. Newest first. Each entry gives
the date, the decision, why, and the alternatives considered (CONTRIBUTING.md §8).

---

## 2026-11-01 · Meta's transient 404 model_not_found (#115)

Twice now, a demo PR's first run failed because Meta answered its intent call with HTTP 404 `model_not_found` for `muse-spark-1.3`, a model it serves: demo-shop #18 in the P4 gate, and #21 in T5.5.

### What we found

| Check | Result |
|---|---|
| #21's runs | Failed at 11:02 and 11:03 (both tries each time, 3 s apart); passed at 11:05. The outage lasted 1.5 to 3.5 minutes |
| In between | `GET /v1/models` listed `muse-spark-1.3`; small text and video calls to it answered 200; a local intent call with the same recording passed |
| Cost of a failed call | None: no tokens are billed |

### Decisions

1. **The Meta port retries a 404 whose body says `model_not_found`, like a 5xx** (0.5, 1.5, 4 s within the call). Any other 404 is still final.
2. **The intent step waits out a longer outage**: after a failure that looks transient (that 404, a 429, a 5xx, a network error) it tries again after 5, 15, 30, 60 and 90 s, about three minutes, before failing the job. A reply that didn't fit is still tried once more only. Intent is the step nothing else can run without; the run's deadline is 15 minutes.
   - _Alternatives:_ retrying every model call that long (the judges and coverage already degrade to inconclusive or no coverage rather than failing the run).

---

## 2026-11-01 · PM approval, live (T5.5, #44)

This branch was deployed to the Cloud. Then demo-shop #21 was opened with a copy of the correct code, linking #5. The owner pressed Approve (PM) on its passing run, as himself: the owner chose that over asking a second account.

### What we found

| Step | Result |
|---|---|
| Reading permissions | The Intenzo App reads `GET /repos/{repo}/collaborators/{login}/permission` with its current permissions: sumithprabhu admin, 0xNilesh write, octocat read (demo-shop is public). GitHub's docs name no permission for it |
| Runs 1 and 2 | **💥 Intenzo failed** after 20 s and 13 s: Meta answered the intent call with HTTP 404 `model_not_found`, on both tries each time. Run `43c44a55` had read the same ticket 40 minutes earlier, and in between a local intent call with the same recording passed (1 call, $0.0315), as did small text and video calls. Filed as #115 |
| Run 3 | Two minutes later: **✅ 4/4 passed** in 2 m 10 s, $0.21 |
| Approve (PM) | The commit status **`Intenzo / product approval` = success, "Approved by sumithprabhu"**, linking the report, set by `intenzo-ai[bot]`. The comment says "👍 Product approval: `sumithprabhu`" |
| Spend | $0.21, plus $0.03 for the local intent check; the failed calls cost nothing |

### Decisions

1. **The approver check is `policy.approvers` plus write access, by GitHub's permission endpoint.** Maintain counts as write, as GitHub maps it. Teams aren't supported yet.
2. **A stale Approve press is logged; a `/intenzo approve` that can't approve gets a reply.** A button only exists on a passing run, so a press on anything else is an old button. A typed command deserves an answer.
3. **The Verify used the owner's own account**, by his choice, not a second account. The tests cover the non-approver and the approver without write access.
4. **Meta's intermittent 404 `model_not_found` gets its own fix (#115)**: it has now failed two demo PRs' first runs.

---

## 2026-11-01 · Send to agent, live (T5.4, #43)

The Cloud (this branch) and the worker (main, with T5.1 and T5.2) were deployed. Then demo-shop #20 was opened with a copy of the almost-right code, linking ticket #5. The owner pressed Send to agent in its Checks tab.

### What we found

| Step | Result |
|---|---|
| Intenzo run 1 | **❌ 3/4 passed** in 2 m 7 s for $0.22 (a PR's first run: intent from the video, exploring). The failing total's GIF and the chart's SAM GIF showed inline, from the public store |
| The press | Fix request 1 of 3 queued (`agent:28:1`) and posted as `intenzo-ai[bot]`. The check run looked unchanged: GitHub shows nothing on a press, so the owner saw "nothing happening" |
| muse-fixer | Started 9 s later and succeeded in 1 m 47 s: Muse Code 83 s, then typecheck and push. It fixed the planted bug again (`d9ca5c2`, the total's `useMemo` dependencies) |
| Muse Code's usage | `muse-spark-1.3-contributor`, 7 calls, 189,280 input tokens (182,039 cached), 1,673 output. At contributor-mode prices ($0.10 / $0.002 cached / $0.20 per M tokens, dev.meta.ai/docs/pricing-rate-limits) that's **about $0.0014** |
| Intenzo run 2 | On the fix: **✅ 4/4 passed** in 1 m 24 s for $0.09 (the group's intent and paths reused). demo-shop's CI passed too |
| Press to green | About 4 minutes |
| Spend | About $0.31: $0.22 + $0.0014 + $0.09 |
| Re-run | Pressed too; logged, nothing else, as built |

### Decisions

1. **The report says when a fix was requested**: "🤖 Sent to `@intenzo-fixer` for a fix (request 1 of 3)" in the comment and the check run, re-rendered on the press. GitHub gives a press no feedback of its own.
2. **Muse Code is cheap enough to run on every press.** It's billed in contributor mode at about a tenth of Spark 1.3's prices: a fix cost about $0.0014, against $0.09–0.22 for the runs around it.
3. **One request per run, `needs-human` after the last attempt, at most once per request**, as built and tested (§26.3).
   - _Next:_ T5.5 (PM approval); Re-run's handler is still open.

---

## 2026-11-01 · muse-fixer, the reference fixer agent (T5.3, #42)

`agents/muse-fixer` was installed into demo-shop's main (`c17d893`, then `81f68cd` and `83d338a`) with the owner's go-ahead, along with a new GitHub App, intenzo-fixer, and demo-shop's variables and secrets. Then a signed request for C2 was posted, as `intenzo-ai[bot]`, on a draft scratch PR (demo-shop #19) holding a copy of the almost-right code. Drafts start no Intenzo run.

### What we found

| Check | Result |
|---|---|
| The Intenzo App's own PR comment | Its workflow run was **skipped** by the job's `if` (no `@intenzo-fixer`) |
| First request | Stopped at "Install Muse Code": `sh: set: Illegal option -o pipefail`. The installer is a bash script, and the documented `curl … \| sh` only works where `sh` is bash (macOS, where T0.2 ran it). Fixed by piping it to `bash` |
| Second request | **Success in 2 min 7 s**: check 1 s, install 4 s, Muse Code install 12 s, **fix 99 s**, typecheck 3 s, push 1 s |
| The fix | One line in `components/CartView.tsx`: the total's `useMemo` depended on `[lines]` and now on `[lines, code]`. That's the planted bug (the total stayed $50.00 until a reload) |
| The push | Commit `f227f3d` by `intenzo-fixer[bot]` started demo-shop's CI on the PR, which **passed**: typecheck, lint, format, unit and e2e |
| Spend | Not captured: the fixer discarded Muse Code's output. It now logs Muse Code's `run.usage` events, so T5.4's run will show it. Muse Code ran 99 s, capped at 20 model steps |
| Clean-up | The scratch PR is closed and its branch deleted |

### Decisions

1. **The App token is minted only for the push**, after the typecheck, the last step that runs the PR's code, and reaches git through its environment. §26.4 minted it before the checkout, so the PR's code ran while a token that can push existed.
2. **The request's signature covers all of it**, not only runId, criterion ids and head SHA. A real request edited by hand fails too.
3. **check refuses a PR that moved on** from the failing commit, or that's closed. The fixer checks out that exact commit.
4. **A fix that touches `.github/`, `package.json` or a lockfile is refused**, and so is an empty one. Muse Code gets at most 20 model steps.
5. **The payload module lives in core with no dependencies**, and `install-into` copies it into the target repo next to the fixer's script. One format for the Cloud (T5.4) and the agent.
   - _Next:_ T5.4 posts these requests from the Send to agent button.

---

## 2026-11-01 · SAM for the canvas criterion (T5.2, #41)

C4 recorded on the almost-right preview (#17's code); its evidence window (Tt−1 s to Tt+3 s) cut at 10 fps into 40 frames, the last one held to 50, H.264. Then each way of naming the discount slice was tried on that clip, once. The SAM output is kept as a fixture (`fixtures/sam/c4-point.txt`).

### What we found

| Prompt | Result |
|---|---|
| ARCHITECTURE §23's plan: a text concept plus the region's DOM box | **Not possible.** Meta's docs: a request names its target "in one of two ways, never both"; a phrase with box or point prompts answers 400 `object prompts cannot be combined with a phrase` |
| Concept "discount slice" | 0 frames, 3.7 s |
| Concept "chart slice" | 0 frames, 4.2 s |
| Concept "green slice" | 49 frames, the slice's box [899,321,958,375] (the still shows it at about 899–958 × 320–378), confidence 0.80, 5.7 s |
| Spark 1.3 asked to point at "the discount slice of the savings chart" on the frame at Tt+1000 | (944, 348), on the slice; 4.7 s; 1,337 prompt and 513 completion tokens, about $0.004 |
| SAM point prompt at (944, 348) on frame 20 | 49 frames (none on frame 0, before the slice appears), the same box, confidence about 0.96, 7.4 s |
| Masks | one_bit, as for every point prompt; a 55 × 60 raster over the 60 × 55 box: the raster covers the box (`@meta-sam/graphics` scales it into x1…x2+1) |
| Judged C4, end to end (`pnpm intenzo run --local`), twice | Pass (agreed) both times; Spark pointed at (915, 360) then (930, 347), both on the slice; 49 masks each; the still shows the discount slice outlined. 29 s, $0.029 a run |
| Spend | The experiment about $0.05, the two judged runs $0.058: about $0.11 |

### Decisions

1. **SAM gets a point that Spark 1.3 picks on the frame at Tt+1000, and tracks it both ways.**
   - _Why:_ SAM's phrases name what things look like ("green slice"), not what they mean ("discount slice"), and the criterion only says what they mean. A point is also one object, with no choosing among a chart's slices. Confidence 0.96 against 0.80 for the best phrase.
   - _Alternatives:_ Spark writes a phrase "as it looks" and the region's box filters SAM's objects (two places to go wrong); the region's box as SAM's prompt (it outlines the whole chart).
2. **A mask is drawn as an outline only, 3 px.** A 25% red fill turned the green slice olive, and color is what a visual criterion is about.
3. **The fallback is the element's box (T5.1), not the annotated screenshot.** It's the same highlight the judges' screenshot uses, animated over the window. It's used on a SAM timeout (20 s), an error, a point that finds nothing, or no masks.
4. **`@meta-sam/parser` 0.1.0 decodes the masks** (Meta's own package, no dependencies, SAM License: use and redistribution allowed with the license kept). Both encodings are range-coded with a context model, 490 lines to port, so it isn't re-implemented.
5. **A visual criterion's GIF is inline in the comment when it passes too.** Otherwise C4's highlight would appear nowhere (the report shows videos), and the demo (§32) shows it.
   - _Next:_ T5.3, the muse-fixer reference agent.

---

## 2026-11-01 · Evidence GIFs for DOM targets (T5.1, #40)

C2 recorded on the almost-right preview (#17's code) with the worker's own recorder, and its evidence rendered over the judges' window (Tt−1 s to Tt+3 s); then the judged C2 run end to end with `pnpm intenzo run --local`.

### What we found

| Check | Result |
|---|---|
| First render | The GIF and still came out, **with no outline**. The box track held 3 samples for the whole lane, at Tt−1.2 s, … +3.4 s, each with a box |
| Why | The poller samples every animation frame but records a box **only when it changes** (`boxes.ts`). The renderer looked for a sample within 250 ms of each frame, so frames between changes had none |
| After the fix | Outlined on 40 of 40 frames; the still shows the Total at **$50.00 in red, after Apply**, under the "Discount (SAVE10) −$5.00" line |
| Size | 85 KB at 640 px and 8 fps for the 4 s window: the 2 MB ladder (fps first, then width) is a safeguard, not the usual path |
| Judged C2, end to end | Failed by both judges, re-recorded to confirm; the GIF (84 KB) and still went beside take 2's video, the take the verdict rests on, with the total outlined. 34 s, **$0.034**. An earlier judged run while debugging cost about the same; the recording-only check calls no model |

### Decisions

1. **The box at a frame is the last one the track recorded at or before it, up to 50 ms after it allowed for frame timing.** A null sample ends it.
   - _Alternatives:_ record every frame's box (60 samples a second per target, drained at every reading), or interpolate. Neither adds anything for a page that only changes on actions.
2. **The outlined element is the first element watch target that shows during the window**, a box held from before it included. Regions aren't in the box track, so a card is never boxed.
3. **Evidence goes to the public store only when GitHub says the repo is public.** The Cloud reads `base.repo.private` from the PR it already fetches for the bundle, at every spawn, and sends `evidenceStore`; anything else (a private repo, a reply without the field, no bundle) keeps it private. §28 had said public GIFs are for public repos, but nothing enforced it.
   - _Alternatives:_ a visibility column filled from webhooks: a migration, and stale when a repo changes visibility.
4. **Passes get a GIF too, not inconclusives;** the comment inlines only a fail's, as §26.1 shows. A render that fails loses the GIF, never the verdict.
   - _Next:_ T5.2 adds SAM for the canvas chart (C4).

---

## 2026-11-01 · P4 gate (#39)

`pnpm gate:p4` (`scripts/gates/p4.ts`) scores hosted runs against the golden comment, and passed on six runs of two demo-shop PRs that close #5: #17 on the almost-right code and #18 on the correct code.

### What we found

| Check | Result |
|---|---|
| `pnpm check:all` | 8 test runs passed |
| Almost-right, 3 runs | Each "❌ 3/4 passed": the total ❌ (its readings "+0 s $50.00 · +1 s $50.00 · +3 s $50.00"), the line, the expired code and the chart ✅. Every run's criteria came from the PM's recording |
| Correct, first 3 runs | **"Not verified", all three.** The first intent call got HTTP 404 `model_not_found` from Meta's API while #17's identical call succeeded; the worker reported an empty intent, the Cloud kept it as the ticket's intent version, and the next two runs reused it |
| Correct, 3 runs after the fix | Each "✅ 4/4 passed": no false fail |
| Verdicts | 0 of 24 inconclusive |
| Time | Median 75 s verifying (66–126 s), 88 s from the push. A PR's first run takes about 50 s more (intent from the recording, exploring) |
| Cost | Median $0.079 a run; $0.18–0.20 for a PR's first run. The gate's twelve runs (the six scored, the three empty ones, three earlier on these PRs): about $0.85, of which about $0.25 Baseten |
| One run looked slow | A watcher saw a correct run's result after 756 s; GitHub has its check run completed 83 s after the push. The watcher's polling, not Intenzo |

### Decisions

1. **A failed intent call is tried once more, and a second failure fails the job**, so no empty intent is reported as the ticket's; **the Cloud never reuses an intent version with no criteria**.
2. **The golden comment is matched by what each criterion is about** (owner's choice), and the total's readings without the after-reload reading the video's criterion doesn't ask for (`demo/README.md` updated).
3. **`gate:p3`'s live part isn't rerun here**: it records on demo-shop served locally and passed on 2026-10-31 (P3 gate). `gate:p4` reads the hosted runs it scores; it creates nothing and calls no model.
4. *Next:* P5 (evidence GIFs, the fix loop, PM approval). The ⚠️ unrequested-change line of the golden comment comes with T5.6.

---

## 2026-10-31 · Hosted intent: the PR's ticket and its recording (T4.8, #107)

P4's goal has a PM's video become criteria on hosted runs, but no task built §8's context bundle, so hosted jobs read the fixtures. T4.8 was added for it. Checked with 22 new unit tests and a hosted run on demo-shop#16.

### What we found

| Check | Result |
|---|---|
| Downloading #5's recording with the App's installation token, demo-shop private | **404**, with the token or without: an App can't fetch a private repo's attachments. ARCHITECTURE §8 assumed a public demo repo |
| The owner's choice | **Make demo-shop public** (2026-10-31). Its 35 commits on 4 branches were scanned first: no key-shaped strings, neither demo secret, only an `.env.example` of empty placeholders. Then the recording downloaded with no credentials (200, 504,961 bytes, the same file as `probes/demo/pm-ticket.mp4`) |
| Hosted run, demo-shop#16 ("Closes #5", the almost-right code) | Criteria from the recording at +61 s, in the PM's order: C1 the total, C2 the line, C3 the expired code, C4 the chart. All four explored; C1 ❌ (confirmed on a second take), C2–C4 ✅: **❌ 3/4 passed** in 127 s, 💲 $0.20 |
| C1's readings | "+0 s $50.00 · +1 s $50.00 · +3 s $50.00": this exploration watched the total itself. No "after reload": the PM never asks for the total to survive a reload, so the criterion from the video has no reload probe (the hand-written C2 fixture did) |
| The comment's header | Named no ticket: the run group didn't keep it. It does now |

### Decisions

1. **The Cloud builds the bundle at spawn; the worker reads it** (§8, §19 step 0), and gets signed URLs only: it never holds a GitHub or Blob credential (§29).
2. **demo-shop is public**, as §8 assumed. *Still the owner's:* rotate the demo's hook secret and bypass, which were pasted in a chat earlier.
3. **A bundle that can't be built doesn't stop the run**: the job falls back to the fixtures, and the Cloud logs why.
4. **The P4 gate's golden test matches criteria by what they're about, not by number** (owner's choice), since the PM's order makes the total C1; and C1's readings line is compared without the after-reload reading the video's criterion doesn't ask for.

---

## 2026-10-31 · Streaming comment, live (T4.7, #38)

The comment's stages, checked live on demo-shop#15 with both judges on Modal, and the fixes that run needed. 3 new unit tests and a new snapshot (the criteria listed before any verdict).

### What we found

| Check | Result |
|---|---|
| The first hosted run with judges | **Four inconclusive in 38 s.** Modal preempted the container; the shim stopped the worker with SIGTERM, but Playwright's own SIGTERM handler kept Node alive five seconds to close the browser, and the job raced on with a dead one, posting verdicts and `finished`. Modal restarts a preempted function on the same input |
| The second run, after the fixes | waiting for the preview → criteria listed (0/4) at +25 s → C3 ✅ +49 s → C1 ✅ +57 s → C4 ✅ +74 s → C2 ❌ +86 s (after its re-record) → **❌ 3/4 passed**, "Judges: Spark Open + Spark 1.3", ⏱ 1 m 8 s |
| Its cost | The worker reported $0.104 (navigator and judges), but the Cloud didn't keep it: no 💲 in the comment |
| C2's readings line | "+0 s Subtotal $50.00 Discount (SAVE10) −$5.00 Total $50.00 Canvas tote bag …": the navigator chose the order summary's box as the "order total" element, so the element's text is the whole summary. The judges still cited $50.00 correctly |

### Decisions

1. **`run_job` is `nonpreemptible`** (CPU and memory at 3x, about $0.025 for a two-minute job), and **the worker exits at once on SIGTERM or SIGINT**, so a stopped job posts nothing more.
2. **A `finished` event's cost and timings are kept on the run**, for the final stage's ⏱ and 💲.
3. **A failed row shows the readings between what was expected and what the judges saw**, as §26.1 draws it, and the readings line keeps to the watched element (or the live regions' changes).
4. *Open for the P4 gate:* the golden test needs C2's line to read "+0 s $50.00 · +1 s $50.00 · …", so the navigator must watch the total itself, not its container. That's a `navigate.v1` change, checked by the gate's runs.

---

## 2026-10-31 · The judge queue in the worker (T4.6b, #37)

The verify job judges now: two recording slots and a judge queue, the §19 e re-record, liveness checks, and the spend in `finished`. `pnpm intenzo run --local` runs it without the Cloud. Checked with 9 new worker tests and two local runs on the almost-right and main previews.

### What we found

| Check | Result |
|---|---|
| Local run 1 (`fixtures/tickets/42.md`, fixture paths) | C1 ✅, C2 ❌ (re-recorded, confirmed), C4 ✅, but **C3 inconclusive (`wrong_target`)**: both judges said pass, one marked the target wrong, since the toast is read from the live regions (no box) and the boxes were on the form. 51 s, $0.082 |
| Local run 2, after the prompt fix | **C1 ✅, C2 ❌, C3 ✅, C4 ✅**, the golden comment's verdicts. 50 s, $0.081 |
| Concurrency | Two criteria were recorded at a time; the run took 50 s for 9 takes and 10 judge calls, against about 90 s one at a time (T2.7b) |

### Decisions

1. **`judge.v1`'s rule 2 now says** that a box around the element's container (its form, summary or region) isn't a wrong target, and neither is a message read from the live regions, which never gets a box. It was amended before any hosted run used it.
2. **Two criteria are judged at a time** (four calls), apart from the two recording slots, so recording goes on while the judges think.
3. **The event cites the take the verdict rests on**: after a re-record, the second PR take.
4. **Without both judges' keys, the job keeps the stub's verdicts**, so a worker missing a key can't post invented ones. **On Modal, `BASETEN_API_KEY` must join `META_API_KEY` in the `intenzo-models` secret.**
5. **Unit tests pass `judges: null`**, so a developer's shell keys can never make one call a model.

---

## 2026-10-31 · The judges, live (T4.6a, #37)

`core/judge/judges.ts`: the two judges, Spark Open on Baseten and Spark 1.3, asked the same thing at once and held to the §22 rules. Checked with 12 new unit tests (scripted ports, Baseten's request shape) and the live test on C1–C4 recorded on the almost-right preview, with main as the base.

### What we found

| Criterion | Spark Open | Spark 1.3 | Combined |
|---|---|---|---|
| C1 discount line | pass, cites "Discount (SAVE10) −$5.00" · 4.3 s · $0.0066 | pass, same value · 10.6 s · $0.0103 | **agreed pass** |
| C2 total | fail, cites readings 6 and 12, "$50.00" · 5.3 s · $0.0075 | fail, cites reading 6, "$50.00" · 9.1 s · $0.0102 | **agreed fail**: reading 6 is the total at Tt+1001 ms |
| C3 expired code | pass, cites "+ alert: This code has expired" · 5.7 s · $0.0081 | pass, same · 7.2 s · $0.0082 | **agreed pass** |
| C4 chart | pass, from the video, no reading · 3.5 s · $0.0058 | pass, same · 8.2 s · $0.0094 | **agreed pass** (`ui_visual`) |

Total: $0.066, of which $0.028 Baseten credit. Each judge's `observed` names the values ("stayed at $50.00 at Tt+1001ms … only changed to $45.00 after the reload").

### Decisions

1. **One chat port for both hosts**: Baseten's dialect is options on the Meta port (`max_tokens`, no `response_format`), not a second client.
2. **Each judge's call fails alone**: a judge without an answer counts as `infra_error` for itself, and the other's answer is kept for the report.
3. **T4.6 is split** (AGENTS.md §5.4): the judges here, the worker's recording slots, judge queue and re-record in T4.6b.

---

## 2026-10-31 · Judge rules (T4.5, #36)

`core/judge/rules.ts`: the deterministic rules around the two judges (§22.1, §22.3, §19 e), moved from the go/no-go (`scripts/gonogo/lib/combine.ts`) and completed. 49 table-driven unit tests; with the bundle's, `pnpm --filter @intenzo/core test judge` runs 54. No model calls.

### Decisions

1. **Two inconclusive judges combine to `judges_disagree`**, as in the go/no-go: §7 has no "both unsure" reason, and the report shows each judge's own words.
2. **A `trigger_absent` lane that the judges pass, or fail on an `uncovered` criterion, becomes inconclusive with `precondition_unmet`** (§22.1). §7 has no closer code: the control the trigger needs isn't there.
3. **The isolation cap comes after the trigger rules**, so a lane missing both says `precondition_unmet`, the more useful of the two.
4. **A fail is re-recorded once to confirm it; a tie once to break it.** A tie is settled only by an agreed verdict one of the first two judges gave; a fail that doesn't repeat is `flaky`.

---

## 2026-10-31 · Judge bundle (T4.4, #35)

`core/judge` builds the bundle both judges get (§22.2) and `prompts/judge.v1.ts` holds their prompt, both moved from the go/no-go (T0.3, `scripts/gonogo/lib`). Checked with 5 new unit tests (a file snapshot of C2's bundle) and a bundle built from C2 recorded live on the almost-right preview and on main.

### What we found

| Check | Result |
|---|---|
| Live, C2 | The annotated still shows the discount line and the order total still at $50.00 at Tt+1000. The bundle: 15 PR readings, the trigger marked at step 3, and the base's "trigger control isn't there at step 2" with its 3 PRE readings |
| The roadmap's "annotation with sharp" | Already done in T1.6 with Chromium (`browser/annotate.ts`), which also keeps fonts and labels consistent with the videos |

### Decisions

1. **The baseline is for comparison only**: its readings carry no index, so a judge can't cite them, and the prompt says it never decides the verdict on its own.
2. **Only the last trigger step is marked `TRIGGER`**, since its time is Tt; a fill before it is still a trigger step in the log.
3. **No frames mode yet**: both judges take native MP4 (T0.2b), so the bundle sends `video_url` parts. A model without video would need it.
4. **The prompt adds three rules to the go/no-go's:** the PM's words go with the criterion, a visual criterion may cite no reading and use the video, and a lane whose trigger never ran can't pass (§22.1).

---

## 2026-10-31 · Coverage (T4.3, #34)

`core/coverage`: Spark 1.3 maps each criterion to the PR's changed files (`coverage.v1`), and `routeOf` gives the routes those files belong to. `pnpm intenzo coverage` runs it. Checked with 25 new unit tests and one live call on the almost-right PR.

### What we found

| Check | Result |
|---|---|
| Live, the almost-right PR (13 files) | C2 → `components/CartView.tsx`, `lib/cart.ts` (`priceCart`, which works out the total), then `lib/discounts.ts`, `app/actions.ts`, `app/cart/page.tsx`. C1 and C3 → the cart view and the discount code; C4 → `components/SavingsChart.tsx` first. All four `covered`; the only route is `/cart` |
| Its cost | 7,095 input and 1,767 output tokens: $0.016 |

### Decisions

1. **Code holds the reply to the diff** (a file it doesn't change is dropped; `covered` needs a file), so a model can't point a criterion at code the PR never touched.
2. **A failed coverage call makes every criterion `unclear`, never `uncovered`**: `uncovered` lets a `trigger_absent` lane fail (§22.1), which a failed call mustn't cause.
3. **A file colocated in an app-router route folder belongs to that route**, and app/'s shared root files (`actions.ts`, `globals.css`) belong to none.

---

## 2026-10-31 · Intent from the PM video (T4.2, #33)

The demo ticket (demo-shop #5, whose text only points at its recording) read with Voice Transcribe and Spark 1.3 watching the video: `prepareTicketVideo` and `extractIntent` in `core/intent`, `pnpm intenzo intent --video`. Checked with 6 new unit tests and five runs of the live test (`intent.live.test.ts`, by hand).

### What we found

| Check | Result |
|---|---|
| The transcript | Voice Transcribe's file endpoint read the 36.5 s narration in 7–10 s, word for word, with the code as "save 10" and a repeated word here and there ("codes codes"). No timings, as in T0.2 |
| The criteria | The first run gave 5: it added "a code field under the items". With a rule that a control other criteria use isn't a criterion of its own, every later run gave the demo's 4, each quoting the PM |
| Media times | One run left them all null. With the recording's length in the prompt and a retry when one is missing, every run had them, in the PM's order but 0.6–5.6 s off (3–4.6 s late in the last run): Spark places them from the picture at 2 fps |
| Numbering | The PM says the total first (9.4 s), then the line (18.5 s), so the intent step numbers the total C1. The golden comment (`demo/expected-comment.md`) and `demo/README.md` ("matched by number") have the line as C1 and the total as C2 |
| Cost | Each run: one transcription (36 s of audio, $0.002) and one Spark call with the video (about 10,000 input and 3,500–6,600 output tokens), $0.03–0.04. T4.2's five live runs: about $0.18 |

### Decisions

1. **With a recording attached, code requires every criterion's `sourceMediaAt`** (one retry), and the prompt states the recording's length.
2. **A control other criteria use is not a criterion of its own**: its place goes in their setup or the repro steps.
3. **Media times stay Spark's estimates for now**: close enough to jump near the moment. *If they must be exact:* transcribe each sentence on its own (split on silence), so each has a start time, and match criteria to sentences by their quote.
4. **Open for the P4 gate:** its golden test can't match criteria by number, since the PM's order makes the total C1. Either match them by what they're about, or re-record the PM video with the line said before the total (the owner's call).

---

## 2026-10-31 · Intent from text tickets (T4.1, #32)

`core/intent` turns a ticket into criteria with Spark 1.3 (`intent.v1`), and `pnpm intenzo intent` runs it. Checked with 15 new unit tests (scripted replies) and one live call on `fixtures/tickets/42.md`.

### What we found

| Check | Result |
|---|---|
| Live, `42.md` (4 checklist items) | 4 criteria in order, matching C1–C4, with concrete values: "$50.00 to $45.00", "This code has expired", `persistence` on C2, `repro.startPath` /cart |
| Its cost | 1 call: 952 input and 4,020 output tokens, 3,455 of them reasoning: $0.018 at list price |
| Spark 1.3's list price | $1.25 / $0.15 / $4.25 per million input / cached / output tokens (dev.meta.ai/docs/pricing-rate-limits, read 2026-10-31); Voice Transcribe $0.18 an hour of audio. Now in `core/models/pricing.ts` |

### Decisions

1. **"Right away" and "at once" count as "instantly"**, so they get `timingMs` 1000 like "instantly" and "immediately" (§18). *Why:* the demo PM says "right away" for C2; without it, C2 would carry no timing claim.
2. **An empty ticket makes no model call** and yields no criteria. Falling back to the PR body (labelled `pr_body`) is the Cloud's choice when it builds the bundle (P4).
3. **After one retry, a reply that still breaks a rule is returned with its problems listed**, not thrown away, so a run can go on and the problems reach the logs.

---

## 2026-10-31 · P3 gate closed, and hosted runs explore (#31)

This supersedes the P3 gate entry's "`gate:p2` not run". `gate:p2` ran where `apps/cloud/.env.local` exists, on `main` at `c2ada41` with P3 merged, and P3's code was then deployed and checked on a hosted run.

### What we found

| Check | Result |
|---|---|
| `pnpm gate:p2` | **Passed**: 8 test runs, CI green at `c2ada41`, and the hosted run's 8 lanes still match P1's ground truth |
| Modal's `run_job` | Had **no secret at all**: only the web endpoints got `intenzo-worker`. Adding `META_API_KEY` there, as first planned, wouldn't have reached the worker, so jobs would have kept replaying the hand-written paths |
| Hosted run, demo-shop#14 (the almost-right code, no hand-written paths) | Check run complete 137 s after opening the PR; the run took 2 m 9 s on Modal, 37 s more than with the fixture paths. Four `path_saved` events: Wonder found each criterion as `goto /cart → fill "Discount code" → click "Apply"`, with its own watch labels. Verdicts are still the stub's (C2 fails) |
| Its `finished` event | Reports `costUsd: 0`: model calls aren't counted until P4's ledger. The four explores cost about $0.05–0.07 at Wonder's list price |

### Decisions

1. **The worker gets the Meta key in a Modal secret of its own, `intenzo-models`** (`META_API_KEY` only), attached to `run_job` alone.
   - *Why:* the worker drives a browser on untrusted previews; it never needs the endpoints' bearer or the sweep's secret.
   - *Alternatives:* attach `intenzo-worker` to `run_job` too, which hands the worker both.
2. **Hosted runs now explore** with Wonder for any criterion the run group has no saved path for, and replay saved paths after that. That's a few cents of Wonder calls per new PR.

---

## 2026-10-31 · P3 gate (#31)

`pnpm gate:p3` (`scripts/gates/p3.ts`) on demo-shop's two branches served locally (`pr/discount-almost-right` on :3001, `main` on :3000), with Wonder as the navigator and no hand-written paths. The takes were written to a temporary folder.

### What we found

| Check | Result |
|---|---|
| `pnpm check:all` | 8 test runs, all passed |
| `pnpm gate:p2` | **Not run**: it reads the Cloud's database, and this checkout has no `apps/cloud/.env.local` |
| Explore, 3 runs × C1–C4 | **12/12 found**, every one in 2 steps (fill the code, click Apply), 5.5–7.3 s (mean: C1–C3 6.3 s, C4 5.5 s) |
| Replay on the PR | Every lane completed and held P1's facts: the discount line at +0/+1/+3 s, the total at $50.00 until a reload ($45.00 after), the "This code has expired" toast in the live regions, the chart reached |
| Replay on the base | Every lane `trigger_absent` at the code field, with its PRE readings; every video aligned |
| Spend | $0.164 of Wonder calls ($0.011–0.018 an explore) |

### Decisions

1. **The gate scores explored paths with P1's facts, not P1's labels** (`scripts/gates/lib/p3.ts`): the navigator chooses its own watch labels, so a label-by-label comparison would fail paths that read the right things.
2. **The gate exits 2, not 0, while `gate:p2` hasn't run**, so P3 isn't closed on a partial check. *Next:* run `pnpm gate:p2` where `apps/cloud/.env.local` exists, then close #31.

---

## 2026-10-31 · The explore loop on Wonder (T3.4, #29)

Wonder (`muse-wonder-1.0`) explored each of the demo ticket's criteria on demo-shop's almost-right branch (served locally on :3001), with no hand-written path (`packages/core/src/navigator/explore.live.test.ts`, and `pnpm intenzo explore` for C2).

### What we found

| Check | Result |
|---|---|
| Strict `json_schema` and `reasoning_effort: "low"` on Wonder (2 probe calls) | Both accepted; a correct reply in 1.7–2.6 s |
| First live C2 run | Failed 3 times in a row: Wonder fills every field the strict schema lists, so ordinary steps carried a `reason` and `watch`, which `NavAction` refuses |
| After ignoring fields that don't fit the status | C1–C4 each found in **2 steps** (fill the code, click Apply), 5.0–6.9 s each, about 2.6k prompt tokens (much of it cached after the first) and about 500 output tokens |
| The explored C2 path, replayed with `intenzo record` | Same as P1's hand-written path: PR $50.00 at +0/+1/+3 s, $45.00 after the reload; base `trigger_absent` |
| Spend (Wonder $4 / $0.20 / $20 per million input / cached / output tokens) | About $0.012 a criterion; about $0.18 for all of T3.4's calls (the probe, the failed C2 run, the C2 verify, the live test twice) |

### Decisions

1. **The navigator runs on Wonder at `reasoning_effort: "low"` with a strict `json_schema`.**
   - *Why:* 2 steps a criterion at about a cent; the replies parsed every time once inapplicable fields were ignored.
   - *Alternatives:* Spark 1.3 (also takes strict schemas), kept for the vision fallback (§20.5).
2. **The wire reply ignores fields that don't apply to its status; `NavAction` stays strict.**
3. **Neither the criterion's `expected` nor its `text` reaches the navigator**, since the text states the outcome too.

---

## 2026-10-31 · The navigator's outline (T3.1, #26)

Measured with Playwright 1.64.1 (pinned) against a fixture page (`packages/core/src/browser/outline.browser.test.ts`) and local demo-shop `/products`.

### What we found

| Check | Result |
|---|---|
| `page._snapshotForAI()` (what §20.1 planned on) | **Gone**: `TypeError: p._snapshotForAI is not a function` |
| `page.ariaSnapshot({ mode: "ai" })` | Public and documented: aria YAML with `[ref=eN]` on every node, `[cursor=pointer]` on clickables, `/url:` under links, iframe content with `fNeM` refs |
| `page.getByRef(ref)` | Resolves a ref against the frame's latest snapshot, iframe refs included; two identical "Add to cart" buttons get distinct refs |
| demo-shop `/products` | 383 tokens on turn 1, 327 with the banner collapsed (cap 6,000) |

### Decisions

1. **The outline uses the public `page.ariaSnapshot({ mode: "ai" })` and `page.getByRef`.**
   - *Why:* the internal API no longer exists, and the public one gives the same snapshot Playwright MCP uses.
   - *Alternatives:* the `data-iz-ref` fallback, kept behind `buildOutline(page, { fallback: true })` and tested.
2. **The contract test runs in the browser layer** (`outline.browser.test.ts`), since CI installs Chromium only after the contract layer.
3. **Collapsed landmarks drop their controls' refs**, and the model asks for them with an `expand` of the landmark's ref. This keeps `Outline.refs` equal to the refs in the text, so the guard (T3.2) can reject anything else.

---

## 2026-10-31 · P2 gate (#25)

`pnpm gate:p2` (`scripts/gates/p2.ts`) checks the hosted walking skeleton without creating anything, and passed on 2026-10-31 against T2.7b's live run on demo-shop#13.

### What we found

| Check | Result |
|---|---|
| `pnpm check:all`, and CI on `main` (which also runs the Postgres tests) | Green, at `538b0ec` |
| The Cloud's refusals | An unsigned webhook and a sweep without its secret both got 401 |
| P1's ground truth on the hosted run | All 8 lanes Modal recorded (C1–C4 × PR + base) read what `fixtures/ground-truth.json` says, and each cites its `human.mp4` with offsets |
| The report page | 200, 8 videos for 8 lanes; a signed video URL answered 206 `video/mp4` |
| The end-to-end check (T2.7b) | One Intenzo comment on the PR; the superseded run's check run is `neutral` |

### Decisions

1. **`gate:p2` scores the hosted recordings against P1's ground truth instead of running `gate:p1`.**
   - *Why:* `gate:p1` records on demo-shop served locally from two checkouts. The hosted lanes are the stronger check for P2: the same ground truth, recorded on Modal through the session hook and the bypass.
   - *Alternatives:* serve demo-shop's two branches locally for `gate:p1`, outside this repo.
2. **The owner chose, on 2026-10-31, to trade some process for time** (the schedule is behind: P2 was due Oct 30, the deadline is Nov 4):
   - A task PR is merged once CI is green, without asking each time (sets aside AGENTS.md rule 6).
   - `pnpm check:all` runs before each push instead of `pnpm check` before every commit (rules 3–4).
   - One live run per phase: T2.7b's served as this gate's end-to-end check, run once instead of three times.
   - Docs still change in each PR, and work still stops at each phase gate for the owner's review.

---

## 2026-10-31 · Real recordings on Modal (T2.7b, #24)

The Cloud now spawns §8's VerifyJob, with the repo's test secrets sealed at rest and none for a fork's PR, and the worker records the demo ticket's criteria on Modal along the P1 paths, uploads each lane's video and cites it. The checks:

- 44 more unit tests than `main` (the Cloud +38, the worker +5, core +1).
- A local run of the worker's recorder against demo-shop's live previews.
- A live run on demo-shop#13, which also serves as the P2 gate's end-to-end check (the owner chose one live check per phase).

### What we found

| Check | Result |
|---|---|
| Live, demo-shop#13 (the almost-right code) | 94 s from opening the PR to a completed check run. The run took 1 m 32 s on Modal: 8 lanes recorded, rendered and uploaded one at a time. Each criterion's row links a clip of the PR recording, and the readings show C2's bug: the total read $50.00 at +0, +1 and +3 s, and $45.00 only after a reload. The report page held all 8 videos; a signed URL answered 206 `video/mp4` (C2's PR video, 50,957 bytes) |
| Two pushes 7 s apart | The first push's run was superseded: its check run went `neutral` ("Superseded"). The second's completed 113 s after the push, its preview's build included. The PR kept one comment, showing the latest run and "Earlier runs (2)" |
| The clips | The demo paths trigger 0.25–0.35 s into the human video, which starts after the sync marker, so `[Tt − 1 s, Tt + 3 s]` starts before 0. The comment and the page clamp it to 0:00 |
| Locally, against the previews | C2's PR lane completed with 15 readings; its base lane was `trigger_absent` (`main` has no discount codes). Both videos rendered, in about 12 s per lane |
| The Modal image | Debian 13 with ffmpeg 7.1.5, and Chrome for Testing 156 (Playwright 1.64.1's chromium-1248) with its libraries. The deploy with the new layers took 143 s |
| Playwright's errors | Their call logs can list a request's headers, which would include the bypass if that request failed. The worker redacts the job's secrets before anything leaves it |

### Decisions

1. **A repo's test secrets are sealed at rest with AES-256-GCM under `INTENZO_SECRETS_KEY`**, each bound to the repo's GitHub id and its column (GCM's additional data), and opened only by the spawn effect.
   - *Why:* the `*_enc` columns have existed since T2.2 with nothing to fill them. The binding stops a sealed value working in another repo or column.
   - *Alternatives:* one Vercel env var per repo, which doesn't go past the demo repo.
   - The operator stores them with `pnpm repo:secrets`, which reads the values by name from `.env`.
2. **A PR counts as a fork until a `pull_request` event says otherwise** (`run_groups.from_fork` defaults to true), and a fork's job gets `secrets: null` (§29).
3. **`bundleUrl` is nullable until P4.** No task builds the ContextBundle before intent and coverage need it, and the stub worker reads none.
4. **The stub's verdict stands only when the PR lane completed**, citing `[Tt − 1 s, Tt + 3 s]`. Otherwise the criterion is inconclusive with §22.1's reason, `trigger_absent` counting as `precondition_unmet` until the judges can look at it.
5. **A take an earlier job of the run already used is skipped**, since Blob refuses to overwrite and a respawned job records the same run.
6. **Lanes are recorded one at a time for now.** Eight took about 90 s, well inside the gate's 3 minutes; §19's two recording slots can come when the judges add time.
7. *Next:* the P2 gate (#25), `pnpm gate:p2`, with this run as its end-to-end check.

---

## 2026-10-31 · The report: comment, check run and page (T2.7a, #24)

The comment and the check run are now rendered by `core/report` from one report model, which the Cloud builds from the database on every change (`apps/cloud/src/report/model.ts`). Each run has a page at `/r/{runId}`. The worker's results (`intent_ready`, `criterion_verdict`, `criterion_evidence`) are stored, and the job the Cloud spawns is a stub that reports the demo's criteria with fixed verdicts. The checks:

- 34 more unit tests than `main` (core +27, the Cloud +6 after the T2.4 renderer's tests moved to core, the worker +1), with a snapshot of the comment for each outcome in `packages/core/src/report/__snapshots__/`.
- A live run on demo-shop#12.

### What we found

| Check | Result |
|---|---|
| Live, demo-shop#12 | The run took 13 s, from its preview being ready to its end. The comment read "❌ 3/4 passed · attempt 1": the four criteria, C2's expected and observed text, the baseline (`b6b60c7`, the merge base), the judges and a report link per criterion. The check run completed as `failure`, titled "3/4 passed", with the same table. `/r/{runId}` answered 200 with the four verdicts, and a malformed id 404. A second commit added "Earlier runs (1)" to the same comment |
| The check run's Details link | A check run without a `details_url` links to the App's homepage, and intenzo-ai's is set to `https://intenzo-cloud.vercel.app.` (a stray period). Each check run now links to its run's report; the second commit's did |
| Reading the buttons back | Neither GitHub's REST check-run object nor GraphQL's `CheckRun` has the requested actions, so they can only be seen in the Checks tab. The PATCH that carried them succeeded: the conclusion and title came in the same request |
| GitHub's comment limit | 65,536 characters (§26.1). Above it the comment drops its collapsed sections, earlier runs first, then the readings, before it cuts any text |

### Decisions

1. **One report model renders both the comment and the check run** (`ReportModel` in `core/report`), rebuilt from the database each time, so the two always agree (§26.1, §26.2).
   - *Why:* they share one table, and a renderer without I/O is pinned by snapshot tests with no database.
   - The Cloud's T2.4 renderer (`outbox/render.ts`) is gone, and `conclusionFor` moved to core.
2. **Ticket and model text is escaped before it reaches GitHub:** `|`, `<`, `>` and `&` in table cells, and a zero-width space after every `@`, so a criterion can't break the table or notify anyone (§29).
3. **The report page is a capability URL in v0:** anyone with a run's link sees its report. Run ids are random UUIDs, and private videos play through signed GET URLs valid for an hour, made each time the page renders.
   - *Why:* the demo's reviewers open it from the PR without logging in.
   - *Alternatives:* GitHub OAuth with a repo-access check, which §28 plans for private repos. Recorded as risk R13.
4. **Each check run's Details link is its own run's report**, so a superseded run's check run keeps pointing at that run.
5. **The Cloud spawns a `stub` job until T2.7b.** It reports `fixtures/criteria` C1–C4 with fixed verdicts (C2 fails, the others pass), judged by `stub`, then finishes `fail`.
6. *Next:* T2.7b records real videos on Modal and cites them as the stub's evidence.

---

## 2026-10-31 · Artifact upload (T2.6, #23)

The worker uploads its files straight to Blob through presigned URLs the Cloud hands out per file (`POST /api/worker/upload-tokens`, `apps/cloud/src/artifacts/upload-tokens.ts`, `apps/worker/src/job/upload.ts`). The checks:

- 27 new unit tests across core, the Cloud and the worker.
- Deliberately broken rules, to check the tests catch them.
- A live upload into both stores (demo-shop#11).

### What we found

| Check | Result |
|---|---|
| Vercel Blob today ([docs](https://vercel.com/docs/vercel-blob), Aug–Sep 2026) | **A store is private or public, fixed at creation.** Private blobs are read only with authentication: through a function, or a signed GET URL (at most 7 days). Uploads can be **presigned PUT URLs** for one exact path, with content types, a size cap and no overwrite signed in |
| Live, with demo-shop#11's running job | The worker's `uploadArtifacts()` stored a test video in `intenzo-private` (the store shows 1 object, 22.28 KB). A GIF uploaded to `intenzo-public` came back from its public URL identical (200 `image/gif`, 48,823 bytes). A second upload onto the same take was refused by Blob ("This blob already exists"), and a path outside the run got 403 |
| Do the tests catch a broken rule? | Each of these failed a test: accepting any run's path, and presigning with `allowOverwrite` |
| `@vercel/blob` 2.8.2 | Calls its control API (`POST https://vercel.com/api/blob/signed-token`) with its own copy of `undici`, which msw can't intercept: a first test reached vercel.com with a fake token (harmless, refused). The test now points the SDK at a local stand-in with its documented `VERCEL_BLOB_API_URL` override. Presigned URLs encode the flags as `"false"`, and the SDK checks the token's scope (path, operations, expiry) before signing |
| Vercel CLI 48.5 vs 64.5 | 48.5 had no private stores. 64.5.0 (Oct 16; the newest at least two weeks old) has `blob create-store --access` and `vercel api`, but no prefix for a store's env vars. Connected with `--environment production`, a store got only `BLOB_READ_WRITE_TOKEN`, which the second store would collide with. The public API's store endpoints take no prefix either |
| The CLI's side effects | `create-store` pulled the development env into the repo root's `.env.local` (mode 644) and appended `.env*` to `.gitignore`, which would hide the committed `.env.example`. Both times the `.gitignore` change was reverted and the file set to 600. `env ls` prints the start of non-sensitive values, and agents can't delete a store ("cannot be performed non-interactively") |
| The dashboard's connection with the prefix `PUBLIC_BLOB` | Added `PUBLIC_BLOB_STORE_ID` and `PUBLIC_BLOB_WEBHOOK_PUBLIC_KEY`: OIDC, with no read-write token. `issueSignedToken({ storeId })` worked with the function's OIDC token |

### Decisions

1. **Uploads use presigned PUT URLs, one per file, refusing to overwrite**, instead of §28's client tokens.
   - *Why:* the worker holds no Blob credential at all, and the path, the content types, the size cap and the no-overwrite rule are signed into the URL and enforced by Blob.
   - The Cloud checks the path is a plain one under `runs/{runId}/` of the job's own run, and the job is current.
2. **What each store takes:**
   - **Public** (up to 20 MB): GIFs, PNGs, WebPs and JPEGs. GitHub's image proxy has to fetch them.
   - **Private** (up to 500 MB): videos, traces, bundles and stills.
   - URLs are valid 15 minutes.
3. **Each store is reached however it was connected:** `intenzo-public` through OIDC (`PUBLIC_BLOB_STORE_ID`), `intenzo-private` with `PRIVATE_BLOB_READ_WRITE_TOKEN`.
   - The CLI connected the private store with a generic `BLOB_READ_WRITE_TOKEN`. Its value was copied into the sensitive `PRIVATE_BLOB_READ_WRITE_TOKEN` and the generic one removed.
   - The public store was reconnected in the dashboard with the prefix `PUBLIC_BLOB`, by the owner, after the CLI refused to let an agent delete and recreate it.
   - The code takes a token or a store id for either store.
4. **Core's `takePath()` is the one place that builds §28's take paths.**
5. *Next:* T2.7 reads private videos back for the report, through signed GET URLs.

---

## 2026-10-31 · Modal shim (T2.5b, #22)

The Modal app `intenzo-worker` is deployed in workspace `sumithprabhu07` (`modal/app.py`), with the shim in `modal/shim.py`. The Cloud spawns and cancels its jobs from the outbox, and Modal's cron sweeps the Cloud every minute. The checks:

- 6 shim tests (Python's standard library), on macOS and in CI on Linux.
- 10 new Cloud tests.
- Deliberately broken rules, to check the tests catch them.
- Two throwaway PRs on demo-shop (#9 and #10), read back from the Cloud's and Modal's logs, Neon and GitHub.

### What we found

| Check | Result |
|---|---|
| **What a cancelled input sees** (open in T2.5a, not in Modal's docs) | `modal.exception.InputCancellation: Input was cancelled by user`, raised inside the running function. The shim caught it, stopped the worker's group within the 5 s grace (no SIGKILL needed) and reported `failed (cancelled)`, which the Cloud accepted (202) |
| demo-shop#10: cancel through Modal's endpoint while the run was current | `started#0`, then `failed#1000000 (cancelled)`. The run ended `cancelled` within 6 s of the cancel, and its check run completed as `cancelled` ("⏹ Verifying `46a885f` was cancelled.") |
| demo-shop#9: a push superseded a running job | The job's next `/alive` got 410, and it stopped by itself (the shim logged `ended: stale`) before the Cloud's cancel reached Modal. The new commit's run got its own job: `started#0`, then `finished#1` after the 60 s placeholder, ending inconclusive (check run neutral) |
| The first sweep after the Cloud had its secret | `200 {"groups":2,"changed":2,"drained":{"done":7,"failed":0}}`: the runs left over from demo-shop#7 and #8 ended as `error` (`deadline_passed`), and their check runs and comments were completed. The calls in the minutes before the Cloud had the secret got 503, as designed |
| The worker image | Node 24.22.2 (NodeSource), pnpm 10.34.9 from `packageManager`, "Scope: 2 of 7 workspace projects" (core and the worker), 4 production packages. No repo root, `.env` or `.pem` files. The first deploy took 109 s |
| The first `modal deploy` | Failed with `NameError: Header`. FastAPI exists only in the image, and `Header(default=None)` is a default value that Python evaluates while the file loads on the deploying machine. The endpoints now take FastAPI's `Request`, an annotation only FastAPI resolves, in the container |
| `modal secret create --from-dotenv` | Needs `python-dotenv` in the CLI's environment. `--from-json` with a temporary owner-only file (deleted at once) needed nothing more |

### Decisions

1. **The shim treats any exception as a cancellation**, and logs its type. Modal uses `InputCancellation`; signals (SIGINT, SIGTERM) get the same handling.
2. **The stale guard stops a superseded job first; Modal's cancel is the backstop.**
   - A job asks `/alive` every 5 s, so it usually stops before the cancel effect is drained.
   - The cancel still matters for a job stuck between checks, such as a browser hanging.
3. **Each spawn attempt gets a fresh `current_job_id`**, so a job an earlier attempt may have started becomes stale and stops.
4. **Until T2.7 the spawned job is a 60 s sleep**, which ends its run inconclusive ("Intenzo couldn't tell"). T2.7 replaces it with the VerifyJob and stub verdicts.
5. **The endpoints check a bearer secret in code** (`MODAL_ENDPOINT_SECRET`, from the Modal Secret `intenzo-worker`), not Modal's proxy-auth tokens.
   - *Why:* one secret, set from the same local file on both sides (`.env.intenzo-modal`).
6. **Modal settings on Vercel:** `MODAL_SPAWN_URL`, `MODAL_CANCEL_URL`, `MODAL_ENDPOINT_SECRET` and `INTENZO_SWEEP_SECRET` (both secrets sensitive), and `INTENZO_CLOUD_URL`.

---

## 2026-10-31 · Job protocol (T2.5a, #22)

The Cloud now has §9's worker routes: `POST /api/worker/events` and `GET /api/worker/alive`, behind job tokens and the 410 stale guard. The worker has `intenzo job`, which runs a job and reports it. The checks:

- 36 new unit tests: 29 in `apps/cloud` and 7 in `apps/worker`.
- An end-to-end test that runs the real worker CLI against the routes.
- Deliberately broken rules, to check the tests catch them.
- The deployed routes, answering without a valid token and with a token for a run that doesn't exist.

### What we found

| Check | Result |
|---|---|
| The worker CLI, in its own process, against the routes on a local port | `started` stored. After a push superseded its run, `/alive` answered 410 and the worker exited 3 within one 100 ms nap, sending nothing more. About 1 s |
| Do the tests catch a broken rule? | Each of these failed at least one test: dropping either half of the stale guard (the current job id, or the run being over), `/alive` skipping it (the end-to-end test times out), accepting any JWT algorithm, cancelling a job that ended by itself, ignoring a 410, reporting a 410 as a crash, and reusing a seq |
| Modal's docs on cancellation | They don't say what a running function sees when its input is cancelled (an exception, or a signal). T2.5b's live check settles it; the shim's design (stop the process group, then `finally` reports `failed`) doesn't depend on the answer |

### Decisions

1. **T2.5 is split:** T2.5a (Cloud and Node, no Modal) and T2.5b (the Modal shim, spawn and cancel, the sweeper, the live check).
   - *Why:* the Modal account isn't set up yet, and everything but the shim can be built and tested without it.
   - Both halves are on issue #22.
2. **Job tokens are HS256 JWTs with a Cloud secret** (`INTENZO_JOB_SECRET`, on Vercel as sensitive, locally in `.env.intenzo-cloud`).
   - Only the header the Cloud writes is accepted. The signature is compared in constant time.
   - `/alive` doesn't reissue tokens: the deadline doesn't move, so `exp` wouldn't either.
3. **The stale guard is "the token's job isn't the run's `current_job_id`, or the run is done".**
   - *Why:* a superseded run is done, so its job gets 410 even if nothing cleared `current_job_id`.
4. **Events are stored in a new `job_events` table, once per `(job_id, seq)`; a stale job's are not stored.**
5. **`finished` and `failed` end the run through `decide()`, as new facts.**
   - A job that ended by itself isn't sent a cancel.
   - `failed` with the shim's code `cancelled` ends the run as cancelled; anything else ends it in error, with the reason `worker_failed`.
6. **The worker reports everything except a 410, and its exit code tells the shim whether to report a failure itself.**
   - Exit codes: 0 finished, 1 failed (reported), 3 stale.
   - Seqs from 1,000,000 up are the shim's, so its `failed` can't collide with the worker's.
7. *Next (T2.5b):*
   - `modal/app.py` and the spawn and cancel endpoints.
   - The spawn effect setting `current_job_id`.
   - The sweeper, and the live check.
   - A `verify` job answers `failed` (`not_implemented`) until T2.7, so T2.5b decides whether production spawns before then.

---

## 2026-10-31 · Outbox and drainer (T2.4, #21)

Every decision's effects now go to the outbox in `advance()`'s transaction. Drainers run them after each event: the `Intenzo` check run of each run, and one comment per run group (`apps/cloud/src/outbox/`). The checks:

- 33 new unit tests on PGlite and msw.
- 3 Postgres tests that race two drainers on a real server: CI's `postgres:18.6`, the same version as Neon. This Mac has neither Docker nor Postgres.
- Deliberately broken rules, to check the tests catch them.
- A throwaway PR on demo-shop (#8).

### What we found

| Check | Result |
|---|---|
| Two drainers at once, real Postgres (5 rounds each) | One check-run POST and one comment POST every time; the other drainer PATCHes after the advisory lock |
| Do the tests catch a broken rule? | Each of these failed a test: ignoring the lease, retrying before the backoff, claiming an at-most-once row as in flight, skipping the `external_id` lookup, no comment coalescing, taking a human's comment that carries the marker, and not re-posting a deleted comment |
| Hosted, demo-shop#8 (empty commit `1e8f80e` on `main`) | One `Intenzo` check run from `intenzo-ai`, with the run's id as `external_id`. It was created as queued when the PR opened and edited to "Verifying the preview … Baseline: `b6b60c7` (the merge base)" when the preview was ready, 12 s later. One comment from `intenzo-ai[bot]`, posted then edited in place. In Neon: 4 rows done, each in one attempt, and the spawn row pending (no executor until T2.5). Every delivery got 200 or 202 |
| The App's own actions | They come back as webhooks: its check run's `check_run.created`, and its comment's `issue_comment.created` and `edited`. Intake stores them (they're Intenzo's own); nothing handles them yet |
| CI's first run of the Postgres tests | All 3 passed, but the run failed on an unhandled error from teardown. `pool.end()` resolves before its connections have closed, so `DROP DATABASE … WITH (FORCE)` killed them mid-close (FATAL 57P01). A plain drop retried while the database is in use (55006) fixed it |
| CI's log of the unit tests | msw refused a request in T2.3's draft-to-ready handler test, which still passed: the handler caught the error and went on without a baseline. The fake now fails any test that makes a request no route answers, and that test checks the baseline it reports |

### Decisions

1. **The check run is rendered from the run's row when it runs, like the comment, under an advisory lock per run.**
   - *Why:* drainers can run a run's check-run rows out of order. Rendering the current state makes order irrelevant: whichever runs last shows the latest state. The lock keeps two drainers from both creating one.
   - The key is therefore `check:{runId}:{status}`, not §16.4's `check:{runId}:{version}`: a run passes each status at most once.
   - *Alternatives:* versioned PATCHes from the payload. That needs a stored version per check run, and gains nothing over rendering.
2. **`outbox.lease_until` doubles as the retry time of a pending row that failed:** 10, 20, 40 and 80 s, then `failed` after 5 attempts.
   - *Why:* no migration, and one claim query covers both "lease expired" and "backoff over".
3. **Effects without an executor stay pending rather than failing:** spawn and cancel, until T2.5.
4. **At-most-once is a property of the executor:** its rows are marked `done` as they're claimed.
   - It's built and tested now; the agent mention that needs it comes with T5.4.
5. **Every webhook drains after its event; there's no Cloud cron.**
   - *Why:* Vercel's per-minute cron needs Pro (§3). The sweeper is a Modal cron calling `POST /api/internal/sweep`, so it comes with T2.5's Modal app.
   - *Next:* until then, a failed effect is retried by the next event's drain. Deadlines (the `tick` fact) need the sweeper too.
6. **A Postgres test layer (`*.pg.test.ts`, `pnpm test:pg`).**
   - It runs in CI on a `postgres:18.6` service container, and by hand against a local server (`INTENZO_TEST_PG_URL`).
   - It isn't part of `check:all`, because a machine without Postgres can't run it.
   - Each test file creates a fresh database and drops it afterwards.
   - *Alternatives:* Docker locally, as the roadmap planned. It isn't on this Mac, and installing it, or Postgres, waits for the owner's go-ahead.
7. **The comment and check-run text is one status line per run until T2.7's report renderer.**

---

## 2026-10-31 · Deployments and baseline resolution (T2.3, #20)

The Cloud now handles `pull_request` and `deployment_status` (`apps/cloud/src/github/handlers.ts`). It acts as the App through installation tokens, and gives each run that starts verifying a baseline (`apps/cloud/src/runs/baseline.ts`). The checks:

- 84 new unit tests in `apps/cloud` (and 2 in core), against msw-mocked GitHub and PGlite.
- Deliberately broken rules, to check the tests catch them.
- A throwaway PR on demo-shop (#7), read back from the Cloud's logs, Neon and GitHub's delivery log.

### What we found

| Check | Result |
|---|---|
| The T0.4 deliveries played through the handlers | PR #2 opened, pushed, then its Preview deployed: the pushed run verifies that preview, with the merge base's Preview as its baseline. The merge base's Production deployment is skipped before its status is read |
| Do the tests catch a broken rule? | Each of these failed at least one test: dropping the production check (from matching, the deployments lookup or the handler), the PR-head check, the fact's own preview, the first-parent walk, the drift limit, or the guard that keeps a failure from replacing a success |
| Hosted, demo-shop#7 (empty commit `b4e35b0` on `main` `b6b60c7`) | The Cloud's log: `run c550bcd3 (b4e35b0 #1, opened): waiting_inputs`, then 14 s later `verifying https://demo-shop-60b7pwtbw-…`, then `baseline main@b6b60c7 (the merge base) at https://demo-shop-dly0m1skm-…`, which is `main`'s Preview. In Neon: `base_sha` `b6b60c7`, `base_drift` 0, `main`'s deployment backfilled from the API, `.intenzo.yml` read from `main`. All 5 deliveries were processed with no error; GitHub logged 202 or 200 for each |
| Vercel's deployments on demo-shop | `main` deploys as Preview (its production branch is `release`), so every `main` commit has a baseline. A redeploy added a second `success` status, with a new URL, to the *same* GitHub deployment. No deployment is ever marked `inactive` |
| `commits/{sha}/pulls` | Lists the open PRs that *contain* the commit, not only those whose head it is |
| Next 16 build once the Cloud imports values from `@intenzo/core` | Turbopack traced the whole project into the webhook function: 250 files, the Cloud's own sources and tests among them. The cause was `readConfig()`'s file reads on a dynamic path. With `/*turbopackIgnore: true*/` it traces 199 files and no sources |

### Decisions

1. **A deployment advances the open PRs whose head is that commit, found with GitHub's `commits/{sha}/pulls` (§16.2).**
   - *Why:*
     - GitHub knows a PR's head even before Intenzo has handled the push. A preview of a commit the PR has already moved past therefore starts nothing, instead of starting a run that the push would supersede.
     - Closed PRs drop out the same way.
   - *Alternatives:* looking the commit up in our own `runs`. It saves one call, but it would start that doomed run, and it can't tell that a PR has closed until a `closed` handler exists.
2. **Production is recognized by name, and the rule errs toward production:** an environment that starts with "prod" or says "production" is never used, on either side, whatever `preview.environment_prefix` says.
   - It's checked before a deployment's status is even read.
   - `repos.prod_domains` is checked as well.
3. **A failure never replaces a stored success for the same commit and environment.**
   - *Why:* the earlier deployment still serves the commit at its URL, so a failed redeploy mustn't hide a working preview.
4. **The baseline is resolved when a run starts verifying, and stored on the run.** The columns are `base_url`, `base_sha` and a new `base_drift`, which the report and §24 need.
   - If the lookup fails, that's logged and the run goes on without a baseline, as §17.3 says for a missing one.
   - *Next:* T2.4 moves the lookup into executing the spawn effect, so the outbox retries it.
5. **`.intenzo.yml` is read from the default branch on each PR event and stored in `repos.config_json`; deployment events use the stored copy.**
   - *Why:* a PR mustn't be able to change the rules it's verified under.
   - A config with problems is logged and nothing runs.
   - *Next:* T2.7 reports config problems on the PR.
6. **Repos and installations are added from any event**, because installation events aren't handled yet.
7. **Tests mock GitHub with msw 3**, as the roadmap asks, plus PGlite for the database.
8. *Next:*
   - The effects (check runs, the comment, spawn) are only logged until T2.4's outbox runs them.
   - Nothing ends a run whose PR is closed, and nothing applies `policy.run_on` or `allow_forks` yet.
   - demo-shop#7's run stays `verifying` until the sweeper's deadline exists.

---

## 2026-10-31 · Run state machine and tables (T2.2, #19)

`apps/cloud/src/runs/transition.ts` holds the §16 machine as pure functions; `apps/cloud/src/db/schema.ts` holds every §11 table (migration `0001_run_tables`). 27 table-driven tests cover the machine and 7 cover the tables, all on PGlite. `pnpm db:migrate` applied both migrations to Neon.

### What we found

| Check | Result |
|---|---|
| The six roadmap cases and seven edge cases | All pass as sequences of timed facts through `decide()`, comparing the runs and effects after each fact |
| Do the tests catch a broken rule? | Timing out at `>` instead of `>=` 20 min failed 5 tests. A push that didn't supersede failed 2 |
| A run from `decide()` written to `runs` and read back | Equal field for field |
| Neon after `pnpm db:migrate` | 11 tables, 2 migrations; `runs_state` and `runs_outcome_when_done` present |

### Decisions

1. **`decide()` per run group, next to `transition()` per run.**
   - *Why:* four of the roadmap's six cases are about runs that don't exist yet: creating one, superseding the active one, re-opening a timed-out one. A function of one run can't express those. `decide()` returns the runs to create, the runs that change and the effects, so the database layer stays load → decide → write (§16.4).
2. **`runs` gains `created_at` and `outcome_reason`; `model_calls` gains `created_at`.**
   - *Why:* §16.3 orders runs by `created_at` and §16.1 times the preview wait from it, but §11 didn't list it. The comment has to say *why* a run ended without verdicts ("preview not ready"), which an outcome alone can't. §30's timeline needs `model_calls` in order.
3. **The database enforces the states too:** CHECK constraints on the state columns, and the outcome is set exactly when a run is done.
   - *Why:* the machine is the only intended writer, but a bug in a later handler would otherwise store a run that's "done" with no outcome.
4. **`error → neutral` and `cancelled → cancelled` on the check run, alongside §22.5.**
   - *Why:* "fail toward inconclusive" (CONTRIBUTING §5): Intenzo's own failure mustn't block a merge.
5. **Edge rules, as tested:**
   - a push to a draft PR supersedes the active run without starting one
   - another ready event for the same commit adds no run
   - a redeploy of a commit that's already verifying changes nothing
   - a reporting run is superseded like any other unfinished run (§16.3)
   - *Next:* the handlers that load a group and write the decision come with T2.3 (deployments) and T2.4 (the outbox for the effects). `policy.run_on` isn't applied yet.

---

## 2026-10-31 · Webhook intake (T2.1, #18)

`apps/cloud` is now a Next.js 16.4.3 app with `POST /api/github/webhook`, live at https://intenzo-cloud.vercel.app. It was checked three ways:

- Its 49 unit tests include every §12 event type from the T0.4 fixtures, run against a real in-process Postgres.
- `next start`, with a migrated PGlite socket server, received real fixture deliveries over HTTP.
- Hosted: the real App, **Intenzo Ai** (`intenzo-ai`, id 5551372; "Intenzo" was taken), was installed on demo-shop only. A throwaway PR there (demo-shop#6) was opened, checked and closed. GitHub's delivery log and `webhook_events` (Neon) were then compared.

### What we found

| Check | Result |
|---|---|
| Fixture deliveries through `next start` + node-postgres | `pull_request.opened` → 202; the same delivery again → 200 `duplicate`; `deployment_status` → 202; Vercel's `check_run` → 200 `ignored`; a wrong secret → 401. The work `after()` deferred then marked both stored rows processed |
| `deployment_status` payloads | They carry `"check_run": null`. The first envelope schema only allowed the key to be absent, so it answered them with 400 |
| A 64-bit id stored through `$1::jsonb` | `9007199254740993` reads back with every digit; `JSON.parse` turns it into `…992` |
| A duplicate insert (`ON CONFLICT DO NOTHING`) | Still uses up an identity value, so row ids have gaps. Nothing relies on them being dense |
| The hosted path, demo-shop#6 | GitHub's log: 7 deliveries answered 202 (`installation` ×1, `installation_repositories` ×2, `pull_request.opened`, `deployment_status` Preview `success` for the PR's head `f3cbadc`, and Vercel's comment created and edited), 8 answered 200 `ignored` (`check_suite`, Vercel's and Actions' `check_run`s). `webhook_events` holds exactly those 7, all processed, no error. The 2 earlier deliveries got 500: they came before the App's id and secret were on Vercel |
| Registering the real App | GitHub's form came up without the manifest's settings, and the App was created with no permissions and no events (`GET /app`: `{}` and `[]`). It was then set by hand to exactly the §12 permissions and events, checked against `manifest.ts` through `GET /app` and the installation's accepted permissions. The webhook URL and a generated secret were set through `PATCH /app/hook/config`. Why the manifest didn't carry is unknown; GitHub's password confirmation dropping the POST is the likeliest cause |
| Vercel CLI deploys from the repo root | The CLI doesn't read `.gitignore`. Its defaults skip `.env.local` but would upload `.env`, `.env.github-app` and the App's `.pem`; `.vercelignore` keeps them here (the upload is 3.5 MB). A project created by the CLI before its Root Directory was set kept the framework preset "Other"; `apps/cloud/vercel.json` pins Next.js. `engines` `24.x` overrides the project's Node 26 default |
| Neon from the Vercel Marketplace | Sets `DATABASE_URL` (pooled) and `DATABASE_URL_UNPOOLED`, among others, for all three environments. Postgres 18.6. `pnpm db:migrate` applied the migration over the direct connection |

### Decisions

1. **Unit tests use a real Postgres, in-process (PGlite), with the production migrations.**
   - *Why:* the rules worth testing live in SQL: the unique `delivery_id`, `ON CONFLICT`, jsonb. PGlite runs them with no Docker and no network, in about a second per test file, so they stay in the unit layer and run in CI.
   - *Alternatives:* an in-memory fake would test our assumptions about Postgres, not Postgres. Docker isn't on every machine; it isn't on the one this was built on.
   - *Next:* T2.4's two-drainers test needs real concurrent connections, which PGlite (one connection) can't give, so that test needs a Postgres server (Docker locally, a service container in CI).
2. **The payload is stored as the request body cast to jsonb in SQL, never as `JSON.parse` output.**
   - *Why:* T0.4 found 64-bit ids that `JSON.parse` rounds; Postgres keeps them exact.
3. **Intake stores only §12 events, and only Intenzo's own check runs. Everything else gets 200 and is dropped.**
   - *Why:* this is T0.4's decision 6. The App receives `check_suite` and every app's `check_run` on each push; storing them would bury the events that matter.
4. **Dispatch is deferred with Next's `after()`, not `waitUntil()` from `@vercel/functions`.**
   - *Why:* both Next.js and Vercel recommend `after()` from Next 15.1 on. On Vercel it extends the function the way `waitUntil` does. §12 is updated.
5. **The real App gets its own credentials file (`GITHUB_APP_ENV=.env.intenzo-app`), next to T0.4's throwaway App.**
   - *Why:* the scripts kept one App's credentials in `.env.github-app`, so a second registration meant `--force` over the first. Only gitignored `.env.<name>` files are accepted, and `.env.example` is refused, because git commits that one.
6. **Intenzo Cloud is the Vercel project `intenzo-cloud` on the demo account (sumithprabhu), deployed with the CLI from the repo root.**
   - *Why:* demo-shop already lives on that account. A Git-connected project would need Vercel's GitHub App on 0xNilesh's account, which this account can't install, so deploys are `vercel deploy --prod` from a checkout (apps/cloud/README.md).
   - *Next:* connect Git when the repo's owner can, so merges to `main` deploy by themselves. Only the App's id and webhook secret are on Vercel; its private key goes there when the Cloud first calls GitHub (T2.3, T2.4).

---

## 2026-10-30 · Video outputs (T1.7, #16)

Measured on 5 synthetic lanes (the cart page, a fill and a click, then the page painted red at a known canonical time), recorded with `openLane`, aligned with `alignVideo` and rendered with `renderVideos`. `video.browser.test.ts` runs the same check on every PR.

### What we found

| Check | Result |
|---|---|
| `human.mp4` | H.264, 1280×720, yuv420p, 25 fps (the raw rate), faststart |
| `judge.mp4` | H.264, 960×580 (540 + the 40 px band), yuv420p, 4 fps |
| Red frame vs `redAt + offsetMs`, human | −19 to +13 ms (the raw video's 40 ms frames) |
| Red frame vs `redAt + offsetMs`, judge | +161 to +231 ms: always in [0, 250), the first 250 ms slot at or after the paint |
| Frame for frame (browser test) | the human red frame is the raw one shifted by the cut, and the judge's is the first grid slot at or after it, both to ±1 ms |
| Marker green left in either video | none (even at a 5 % pixel share) |
| Render time, both videos | 1.1–1.5 s for a 5 s lane, with Chromium already running |
| Raw recording | **VP9**, not VP8 as §21.4 said: 25 fps constant, starting at 0 (Playwright 1.64). Nothing depends on the codec |

### Decisions

1. **Both videos start after the marker; the judge video samples a 250 ms grid counted from the lane start.**
   - *Why:* the green flash and the blank frames before it are noise to a judge. On the grid the stamps are round (`t=12.250s`), and with ffmpeg's `fps=4:round=up` each frame shows the last raw frame at or before its stamped time, so a judge's `atMs` never points before what it saw.
   - *Alternatives:* `fps`'s default `round=near` shows frames up to 125 ms *after* their stamp; stamping the raw video's own times gives ragged stamps.
2. **Only the text is drawn with Chromium: one PNG per judge band and one per caption stack, overlaid by ffmpeg.**
   - *Why:* no `drawtext` (§13), and the T0.3 prototype screenshotted whole frames, which is slower than drawing the 960×40 band.
3. **Captions stack (1.5 s each, at most three) in the human video's bottom-left corner, over the page.**
   - *Why:* the human video stays 1280×720 (§21.4) and is for people, not the judges. A fill and a click 80 ms apart each stay readable. Values typed into secret-looking fields are masked, since videos are shared.
4. **`renderVideos` takes an optional second argument `{ browser }`** to reuse a running Chromium; without it, it launches one.

---

## 2026-10-30 · Phase 0 gate: PASS (#9)

`pnpm gate:p0` (`scripts/gates/p0.ts`) passed **8 of 8** checks:

| Check | Result |
|---|---|
| `pnpm check:all` | passed |
| CI on `main` | green (`c07c735`, with T0.7 merged) |
| `probe:assert` | all 22 capability checks answered (20 ok, 2 unsupported, 0 errors) |
| Ground truth on demo-shop's `pr/discount-correct` preview | C1–C4 pass |
| Ground truth on `pr/discount-almost-right` | C1, C3, C4 pass; C2 fails as planted; ⚠️ "Continue" |
| DECISIONS.md | records the go/no-go and the five P0 choices |
| `demo/expected-comment.md` | covers C1–C4, C2's readings and ⚠️ |
| The demo ticket (demo-shop #5) | carries its video |

**The probes were re-run on a second machine for the gate, by the owner's choice.** All 22 reproduced the T0.2/T0.2b answers:
- Spark 1.3: 6/6 correct (computer use clicked inside the Apply button)
- Spark Open: 5/5 correct, native video included
- Wonder: text and video work; it still rejects the `computer` tool
- Muse Code: still no API model; the CLI headless run took 28 s, Muse Code 1.4.14
- SAM 3.1: 50/50 frames at IoU ≥ 0.7 for every prompt type
- Voice Transcribe: correct in both modes, still without timings

**Spend:** about $0.10–0.15.
- *Token-priced, from the responses' usage:* $0.053 (Spark 1.3 $0.027, Spark Open on Baseten $0.014, Wonder $0.012).
- *Per frame:* SAM about $0.03.
- *Not itemized:* the Muse Code run and the transcription.

**Setup on this machine:** the Muse Code CLI was installed with the official installer. The installer and launcher scripts were read first, the launcher's sha256 matched the advertised one, and shell profiles were left untouched (`MUSE_NO_MODIFY_PATH=1`). The probe gets `~/.local/bin` on PATH for its run.

### Decisions

1. **Phase 0 is done; Phase 1 can start**, per the roadmap's gate rule.
2. **Probe media are rendered with Chromium, not ffmpeg's `drawtext`.**
   - *Why:* this machine's Homebrew ffmpeg has no `drawtext`, so the probe media couldn't be generated at all. The ground truth is unchanged (totals, change time, box and button pixels), and a browser test pins the pixels.
3. **The gate checks documents by exact decision sentences.**
   - *Why:* DECISIONS entries are dated history that's never edited, so a missing sentence means a missing decision, not a rewording.

---

## 2026-10-30 · The demo ticket and the golden comment (T0.7, #8)

- **The ticket** is [demo-shop #5 "Discount codes"](https://github.com/sumithprabhu/demo-shop/issues/5). Its text only says "the details are in the screen recording below", so the criteria must come from the video.
- **The video** is a 36.5 s narrated screen recording of demo-shop's cart on `main`, made by `pnpm demo:pm-video`. The repo owner attached it.
- **The golden comment**, `demo/expected-comment.md`, is taken from `pr/discount-almost-right`'s proven ground truth (T0.6).

### What we found

| Check | Result |
|---|---|
| The video plays from the issue | The attachment downloads as H.264 + AAC, 36.52 s, **byte-identical** to the recorded file |
| How the URL appears (private repo) | In `body_html`: a plain `https://github.com/user-attachments/assets/<uuid>` link, **not** the signed `private-user-images…?jwt=` URL §8 expected. An authenticated GET with a user token returned 200 `video/mp4`; an App installation token is untested. |
| The golden file covers C1–C4 + ⚠️ | C1 ✅, C2 ❌ with the readings line (+0 s / +1 s / +3 s $50.00, after reload $45.00), C3 ✅, C4 ✅, and ⚠️ link "Checkout" → "Continue" on /cart |

### Decisions

1. **The PM video is generated, not recorded live.**
   - *How:* a Playwright recording of the real cart, with a drawn cursor and address bar, and narration from macOS `say` (Samantha). Each line is scheduled against the cursor's gesture.
   - *Why:* it's reproducible, so it can be re-made if the cart changes. The narration says exactly what §32 needs, with criteria spoken at known times, so `demo/README.md`'s timeline is the ground truth for each criterion's `sourceMediaAt` (T4.2). A PM recording live would add no information and couldn't be re-made.
   - *Caveat:* a TTS voice is cleaner than a real PM. T4.2 may want one human-recorded take as a robustness check.
2. **The demo ticket is #5, not #42.**
   - *Why:* issues and PRs share numbering in a repo, and reaching #42 would take about 37 throwaway issues. The owner agreed. The golden comment and §32 use #5.
3. **The golden comment is matched on what's deterministic.**
   - *What:* the outcome, each verdict by criterion number, the C2 readings line and the ⚠️ line. Criterion wording comes from the intent step, and links, times, SHAs and cost vary, so they're `{placeholders}` (rules in `demo/README.md`). Prettier skips the file so its bytes stay exact.
4. **§8 is updated for user-attachment URLs, and T4.2 must check that an App installation token can download them.**
   - *Why:* §8 expected signed `?jwt=` URLs in `body_html`, but this private repo gave a plain link. A public demo repo avoids the question (§8).

---

## 2026-10-30 · Seeded demo branches (T0.6, #7)

Two branches in `sumithprabhu/demo-shop` implement ticket #42 (discount codes):
- `pr/discount-correct` (`4c64ff0`)
- `pr/discount-almost-right` (`2be4341`)

Each is one commit with the same message, `feat: add discount codes to the cart`, the way a real implementing agent would write it, and neither names the defect. Both deploy as Vercel **Preview**. `pnpm demo:ground-truth` (`scripts/demo/`) proved each branch's ground truth on its live preview, from fresh shoppers made by the signed session hook, **3 runs in a row each, identical every time**.

### What we found

| Criterion | `pr/discount-correct` | `pr/discount-almost-right` |
|---|---|---|
| C1: discount line at Tt+0 | `Discount (SAVE10) −$5.00` | same |
| C2: total at Tt+0 / +1 s / +3 s; after reload | `$45.00` ×3; `$45.00` | **`$50.00` ×3; `$45.00`** |
| C3: OLD5 toast within 1 s | `This code has expired` | same |
| C4: chart at 344°, before → Tt+1 s | `#f59e0b` → `#16a34a` (the discount slice) | same |
| Cart button (§24) | `Checkout` | **`Continue`** |
| The branch's own tests (local, 5 repeats) | 39 unit, 15 e2e, all green | **all green too**: its tests don't check the total's timing, and its "Continue" rename updated the tests |

**Two surprises:**
- **The first planted bug healed itself.** The total was computed from the page's `initialCode` prop. But the cart's background save sets a cookie, and when a Server Action does that, Next.js re-renders the route. CartView got a fresh `initialCode`, and the total corrected itself about 100 ms later (locally). On Vercel that would have landed before or after +1 s depending on latency, so the label wouldn't have been deterministic. The e2e suite caught it: the "total at once" test passed on the almost-right branch.
- **Next.js puts an empty `role="alert" aria-live="assertive"` route announcer (`#__next-route-announcer__`) on every page.** It announces the page title on client-side navigations, and it made `getByRole("alert")` ambiguous in the tests. §21.3's live-region readings will see it too.

### Decisions

1. **The planted bug is a `useMemo` missing the discount code as a dependency.**
   - *Why:* it survives Next.js's re-render, so the total stays `$50.00` until a reload, every time. Quantity changes still update the total, so `main`'s tests pass. It's also a believable slip for an agent to make.
   - *Alternatives:* a stale prop, which healed itself (above); a total snapshotted at mount, which would also break quantity changes and so `main`'s tests.
2. **The almost-right PR keeps CI green.**
   - *Why:* the demo's point is "CI passes, and the ticket isn't done", which is the gap Intenzo exists for. Its own discount test checks the line, the toast, the chart and the total after a reload, but not the total right away. The unrequested "Continue" rename updates the two tests it would break.
3. **The ground truth lives in Intenzo (`scripts/demo/`), not in demo-shop.**
   - *Why:* the repo under test carries no answer key for its planted bug, so the fixer agent and IntentBench's diff-only arm can't read one. It's also where the P1 gate's ground-truth table and IntentBench's per-case ground-truth checks will live.
   - *Alternatives:* a `ground-truth/` folder on demo-shop's `main`. It would stay out of the PR diffs, but anyone with the repo could read it.
4. **Discount codes are checked in the browser, then again on the server before saving.**
   - *Why:* the correct branch's total changes with no network round trip, so a cold start can't push C2 past 1 s and cause a false fail.
5. **The live-region readings must expect framework route announcers (T1.5).** §21.3 now says so.

---

## 2026-10-30 · demo-shop (T0.5, #6)

**What was built:**
- **Repo:** `sumithprabhu/demo-shop`, private for now.
- **Stack:** Next.js 16.4.3 and React 19.3, deployed by Vercel (Hobby).
- **PRs:** demo-shop #1 is the shop, its test hooks and its tests. #2–#4 are README notes; merging them also gave `main` fresh deploys to check its environment.

**How it was verified:**
- **Locally:** 33 unit tests, and 9 e2e tests that passed 90/90 over 10 repeats.
- **CI:** the same suites on every PR.
- **Live:** against `main`'s protected Vercel preview.

### What we found

| Check | Result |
|---|---|
| e2e on `main`'s preview (`demo-shop-git-main-sumithprabhus-projects.vercel.app`) | **9/9**, through Vercel's automation-bypass header. The session hook made a new shopper per call. |
| Deployment protection | Without the bypass, pages answer 302 (Vercel's login). With `x-vercel-protection-bypass`, they answer 200. |
| Production guard, live | A *correctly signed* session hook on a Production deployment → **403** `test hooks are disabled in production`. |
| Production branch | Setting it to `release` before the `release` branch existed didn't take: pushes to `main` kept deploying as Production (hooks 403, no baseline preview). Set again after the branch existed, a push to `main` deploys as **`Preview`**, with a GitHub Deployment and a `deployment_status` `success`. |
| Hook secret | Vercel stored the first Preview value as sensitive, so it couldn't be read back, and it didn't match the local value (401 `bad signature`). A new value on both sides, plus a new deployment, fixed it. Env changes only reach new deployments. |
| GitHub errors, about 14:24–14:27 UTC | Merge calls returned 500/502. A push to `main` in that window never reached Vercel: no status, no deployment. One PR was squash-merged after rebase-merging kept failing. |

### Decisions

1. **`main` has no discount codes; the demo PRs add them.** This was the owner's choice.
   - *Why:* this is what §32, ticket #42, §19 (`trigger_absent` for new UI on the base lane) and §31 (Muse Code implements tickets for IntentBench) all assume. T0.5's text asked for a SAVE10/OLD5 e2e on `main`, which contradicted them. ROADMAP T0.5 and T0.6 are corrected: the discount feature and its e2e move to `pr/discount-correct`.
   - *Alternatives:* `main` with discounts. The PRs would then change an existing feature, and the base lane would show the correct behavior: a regression story the ticket doesn't tell.
2. **Shopper state lives in cookies.**
   - *Why:* a new identity means a new seed cart (the tote and the mug, $50.00). There's no database, isolation comes per browser context, and it's serverless-safe on Vercel.
3. **The §21.1 hook contract is pinned down, and §21.1 is updated.**
   - *What:* `X-Intenzo-Timestamp` (unix seconds, ±5 min) and `X-Intenzo-Signature: sha256=<hex HMAC-SHA256(secret, timestamp + body)>`. Answers: 403 on production (checked before the signature), 401, 503, or 200 with `{"shopper"}` and `Set-Cookie`.
   - demo-shop's `lib/hooks.ts` is the reference implementation.
4. **Previews stay protected; tests and Intenzo use Vercel's "Protection Bypass for Automation".** This was the owner's choice.
   - *Why:* it exercises §21.2. Intenzo's recorder gets the bypass cookie once; demo-shop's e2e sends the header.
5. **Create the production branch before pointing Vercel at it, and redeploy after changing an env var.**
   - *Why:* both caught us here. demo-shop's README now says so.
6. **demo-shop stays at `sumithprabhu/demo-shop`, private, for now.**
   - *Why:* a repo can't be created in another user's personal account.
   - *Next:* §8 assumes a public demo repo, so the owner decides between a transfer to `0xNilesh` and making it public. Before it goes public, rotate `INTENZO_HOOK_SECRET` and the bypass secret: both were shared in chat during setup, and the hook secret is a short test value.
7. **Local e2e runs on port 3100.**
   - *Why:* another Next server already holds :3000 on the dev machine. §31's :3000/:3001 lanes for P1 may need the same change.

---

## 2026-10-30 · Platform checks: GitHub App, Vercel, check runs (T0.4, #5)

**Setup:**
- **Repo:** a throwaway private repo, `sumithprabhu/intenzo-t04-sandbox`.
- **App:** a throwaway App, `intenzo-demo`. It was registered from the §12 manifest (`pnpm github-app:create`), with exactly the §12 permissions and events, and installed on that repo only.
- **Vercel:** Hobby, deploying the repo.

**How payloads were captured:** read back from the App's delivery log. No webhook server was involved: every delivery got HTTP 502 and GitHub kept the payload anyway. They're in `packages/core/fixtures/github/`, whose README says what each one shows.

### What we found

| Question | Result | Evidence |
|---|---|---|
| (a) **B-7:** does a comment posted with the App's installation token start an `issue_comment` workflow? | **Yes.** The run's actor is `intenzo-demo[bot]`, and the §26.4 guard job ran. A human comment in the same format also started the workflow, and the guard skipped it. Vercel's bot comments start it too, and the guard skips those. | Actions runs 41060157000 (bot) and 41060159944 (human); `issue_comment.created.bot-intenzo-demo.json` |
| (b) **R11:** what does Vercel's `deployment_status` look like? | **It isn't sent until a toggle is on.** On the new Vercel project, Settings → Git → "deployment_status Events" was off, and Vercel's GitHub App wanted a permissions update. Deploys only set a `Vercel` commit status, whose `target_url` is the Vercel dashboard. There was no GitHub Deployment, so no `deployment_status`, and no `repository_dispatch` either. With both fixed, see the next two rows. | commit statuses on the sandbox; the toggle as reported by the owner |
| | GitHub Deployments with environment exactly `Preview` / `Production` (also in `original_environment` and the status). `environment_url` = `target_url` = `log_url` = the deployment's unique URL. `ref` = the commit SHA. **`production_environment: false` even on `Production`.** `transient_environment: false`, `payload: {}`. Only the final `success` status is delivered, no `pending`. | `deployment_status.success.{preview,production}.json` |
| | Vercel also sends `repository_dispatch` `vercel.deployment.pending` / `ready` / `success`. The `client_payload` has a lowercase `environment` (`preview`), the branch in `git.ref`, a branch alias URL and the deployment `url`. | `repository_dispatch.vercel.deployment.success.json` |
| (c) Requested actions: where they appear and who can press them | In the PR's Checks tab. **They can also be pressed on a check run that's still in progress**, contrary to GitHub's docs and §26.2. A press changes nothing on the run. It delivers `check_run.requested_action` with `requested_action.identifier`, `sender` (login, type), `check_run.external_id` and `check_run.pull_requests`. Verified for the repo owner only; a read-only collaborator needs a second account, which T5.5 has. | `check_run.requested_action.approve.{completed,in-progress}.json` |
| (d) `closingIssuesReferences` on a PR into the default branch | A PR into `main` saying "Fixes #1" → `[#1]`. A PR into `develop` with the same body → `[]`. Both asked with the App's installation token. | `graphql.closing-issues-references.*.json` |

**Also found:**
- **Other apps' events reach the App.** It receives `check_run` events for every check run on the repo (GitHub Actions jobs and Vercel's), and `check_suite.requested` on every push, without subscribing to it.
- **Bot logins follow the App's name.** They're `<app slug>[bot]`, and App names are global: this one is `intenzo-demo[bot]`.
- **Delivery IDs overflow JavaScript numbers.** They're 64-bit (beyond 2^53), so `JSON.parse` rounds them. The export script keeps the exact digits.

### Decisions

1. **Keep `deployment_status` as the trigger, and require Vercel's "deployment_status Events" project toggle (R11 resolved).**
   - *Why:* with it on, the payload has everything §17.1 needs: the environment name and the preview URL. It was off on a freshly created project, so it's an onboarding step, not a default we can assume.
   - *Alternatives:* `repository_dispatch` is what Vercel now recommends for Actions, but it's aimed at workflows, has a lowercase environment and isn't in the §12 events. It stays a documented fallback. Commit statuses carry no preview URL (`target_url` is the dashboard).
   - *Next:* T0.5 turns the toggle on for demo-shop and accepts Vercel's GitHub App permissions. Setup docs tell customers to keep it on. When a PR gets a `Vercel` commit status but no `deployment_status`, the run's waiting state should say why (§16.2).
2. **Production is recognized by environment name, never by `production_environment`.**
   - *Why:* Vercel sends `false` on its `Production` deployments. §17.1 and §29 are updated.
3. **Deployments are keyed on the commit SHA.**
   - *Why:* `ref` is the SHA, not the branch, so §16.2's SHA → PR lookup stays the way to find the PR.
4. **The muse-fixer guard reads the bot login from config, as `<app slug>[bot]` (B-7 resolved).**
   - *Why:* App comments do start `issue_comment` workflows, and App names are global.
   - *Next:* T5.3 sets the slug in muse-fixer's workflow.
5. **Requested actions go on completed runs only, Approve on passed runs only, and the handler re-checks the run's outcome.**
   - *Why:* buttons can be pressed while a run is still in progress, and a press carries the run's `external_id`, which is enough to check.
   - *Next:* T5.4 and T5.5.
6. **Webhook intake keeps only `check_run` events whose `check_run.app.id` is Intenzo's, and ignores `check_suite`.**
   - *Next:* T2.1.
7. **§17.2 is confirmed: `closingIssuesReferences` first, then the regex fallback for PRs not into the default branch.**

---

## 2026-10-30 · Judge go/no-go: GO (T0.3, #4)

Measured with `pnpm gonogo` (see `scripts/gonogo/README.md`):

- **Clips:** 10, recorded with Playwright from a local fixture shop whose planted behaviors are proven by browser tests. 4 correct, 4 almost-right (stale total, off by a cent, wrong %, missing error) and 2 ambiguous ("clear confirmation", "updates quickly").
- **Bundle:** both judges get the same `judge.v1` input: the criterion, the step log with Tt, the readings, the annotated Tt+1000 still, and the 4 fps judge clip.
- **Rule:** §22.3 decides.
- **Takes:** one per clip, no baseline.

The run was done twice: at each model's default reasoning effort, and with `reasoning_effort: "low"`. That makes 40 calls, with no retries and no parse failures. Raw answers are in `probes/gonogo/` (gitignored).

### What we found

| Effort | Accuracy (decided) | False fails | False passes | Inconclusive (clear) | Verdict p50 / max | Spark Open p50 / max | Spark 1.3 p50 / max | Cost per criterion |
|---|---|---|---|---|---|---|---|---|
| default | 8/8 = 100% | 0 | 0 | 0/8 | 10.1 / 33.1 s | 6.4 / 11.7 s | 10.1 / 33.1 s | $0.020 |
| `low` | 8/8 = 100% | 0 | 0 | 0/8 | 6.4 / 9.4 s | 3.1 / 4.1 s | 6.4 / 9.4 s | $0.013 |

- **Each judge alone** was also 8/8 at both efforts.
- **Citations:** every pass and fail cited a reading whose value matched (`valueMatches`), with 0 wrong targets. The R13 what-if therefore changes nothing.
- **Missing error:** both judges cited the live-region diff value `no change`. An `absent` reading has no value to cite, so this is how the §22.3 rule handles a missing element.
- **Ambiguous clips:** both judges passed both, at both efforts, and agreed with each other:
  - "updates quickly" was judged at Tt+3000, the prompt's rule when there's no `timingMs`.
  - A grey "Applied" button counted as a clear confirmation.
- **Output format:** Spark Open on Baseten, which has no structured outputs, returned a valid `JudgeOutput` from the prompt alone 20/20 times. Spark 1.3 accepted the strict `json_schema` with `anyOf` nullables.
- **Latency:** Spark 1.3's default effort is the outlier. The stale-total clip took 4,132 reasoning tokens and 33 s; at `low`, 819 tokens and 8.8 s.
- **ffmpeg:** Homebrew's ffmpeg 8.1.1 has no `drawtext` (it's built without freetype). The judge clip's time band and the labels are drawn with Chromium.
- **Spend:** $0.328 in total. $0.139 was Baseten (Spark Open), at list price ($1.25 / $0.15 / $4.25 per million input / cached / output tokens), out of about $1 of Baseten credit. The other $0.189 was Meta (Spark 1.3).

### Decisions

1. **GO. The two judges and the strict §22.3 rule stay as designed; R13 isn't needed.**
   - *Why:* every GO threshold holds with room to spare at both efforts: 100% accuracy (need ≥ 80%), 0 false fails, 0% inconclusive (need ≤ 30%), slowest verdict 33 s (need < 60 s).
   - *Caveat:* small n. These are 10 clips on one simple page, and they were easy for both models. IntentBench (P6) is the real measure, including the false-pass rate (R12).
2. **Both judges run with `reasoning_effort: "low"`.**
   - *Why:* accuracy is the same (8/8), the slowest verdict drops from 33.1 s to 9.4 s, and cost per criterion drops 38% ($0.020 → $0.013). Spark Open, on scarce Baseten credits, costs 47% less.
   - *Alternatives:* the default effort gained nothing here. Revisit if IntentBench shows misses on harder cases, where more reasoning might help.
   - *Next:* T4.6 puts the effort in the model registry, and T6.3 can report both levels.
3. **The intent step must make vague criteria concrete, because the judges don't hedge.**
   - *Why:* the two ambiguous clips came back as an agreed pass, not inconclusive. The agreement rule catches disagreement, not shared interpretation (R12).
   - *Next:* T4.1 turns vague timing words ("quickly", "right away") into a `timingMs`, as §7 already does for "instantly" → 1000. It marks subjective words ("clear", "nice") as `inferred` or raises them as a question for the PM.
4. **An empty live-region diff reads `no change`; keep it (T1.5).**
   - *Why:* it's the citable value for "nothing appeared", which keeps missing-element bugs decided instead of inconclusive. ARCHITECTURE §22.3 now says so.
5. **Overlays never cover the page, and text isn't drawn with ffmpeg's `drawtext`.**
   - *Why:* a timestamp in the top-right corner covered the toast area, and Homebrew's ffmpeg has no `drawtext`.
   - *Decision:* the judge clip carries the time in a 40 px band under the frame (960×580), and the annotation labels sit in a column beside the screenshot.
   - *Next:* T1.4 and T1.7 follow this, and §21.4 is updated.
6. **Spark Open is asked for JSON by prompt; Spark 1.3 uses a strict `json_schema`.**
   - *Why:* Baseten's docs say "All except Muse Spark Open support structured outputs and JSON mode". §14's "JSON mode if supported" covers this; it's recorded so T4.6 doesn't expect structured output from Baseten.

---

## 2026-10-30 · Spark Open on Baseten (T0.2b, #64)

Measured with `pnpm probe:all spark-open` (one call per check) against Baseten Model APIs, using the
same ground-truth media as T0.2. With this, `pnpm probe:assert` passes for all six models (22 checks).

| Check | Result | p50 | Notes |
|---|---|---|---|
| models_list | ok | 2.2 s | `meta-models/muse-spark-open` (1 match among 20 models); no `-1026` id exists |
| text | ok, correct | 1.7 s | first call 1.3 s: no cold start on the shared Model API |
| image | ok, correct | 3.0 s | "50.00" |
| video (native MP4, `video_url`) | ok, correct | 2.8 s | "start=$50.00, end=$45.00"; 946 prompt / 560 output tokens |
| frames (5 timestamped stills) | ok, correct | 5.3 s | same answer; 3,460 prompt tokens |

Cost: about $0.016 of Baseten credits for the run.

### Decisions

1. **Spark Open judges native video, the same inline MP4 Spark 1.3 gets (R2 resolved).**
   - *Why:* It read the clip correctly via `video_url`. Frames mode was also right, but slower (5.3 s vs 2.8 s) and 3.7× the prompt tokens.
   - *Alternatives:* Frames mode stays as the fallback in `MediaEncoder` (§14) if a clip is ever rejected.
2. **The two judges are Spark Open (A) + Spark 1.3 (B), as designed.**
   - *Why:* Both read the judge clip correctly. This supersedes the 2026-10-30 T0.2 entry's item 6 (wait for credits); Wonder stays a tested fallback, not needed now.
3. **Use the discovered model id `meta-models/muse-spark-open` on Baseten Model APIs; no pre-warming.**
   - *Why:* The hackathon guide's `-1026` id isn't served. The first call took 1.3 s, so there's no cold start to pre-warm on the shared Model API (ARCHITECTURE §3 and T7.2 updated).

---

## 2026-10-30 · Model capabilities from the T0.2 probes (#3)

Measured with `pnpm probe:all` against the live APIs, one call per check unless noted. Raw results
are in `probes/results.json` (local and gitignored); see `scripts/probe/README.md` to reproduce.
The probe media has known answers (the total changes from $50 to $45 at 2.5 s, a red box and an
Apply button at fixed pixels, speech saying "forty five"), so "correct" means the model got the
fact right, not just that it replied.

### What the probes found

| Model | Check | Result | p50 | Notes |
|---|---|---|---|---|
| Spark 1.3 | text | ok, correct | 2.1 s | 5 calls |
| | json_schema (strict) | ok, correct | 2.9 s | 5 calls; `{"total":45}` |
| | image (data URL) | ok, correct | 2.7 s | 5 calls |
| | video_inline (MP4 data URL) | ok, correct | 2.9 s | 5 calls; 5 s clip = 1,349 prompt tokens, 1,251 cached on repeat |
| | video_file (Files API) | ok, correct | 5.5 s | 5 calls; `input_video` + `file_id` accepted; upload 2.7 s |
| | computer_use | ok, correct | 5.6 s | 2 turns: screenshot, then a click inside the Apply button |
| Wonder | text | ok, correct | 1.8 s | |
| | video_inline (MP4 data URL) | ok, correct | 4.6 s | same clip and question as Spark; 801 in / 350 out tokens, about $0.01 |
| | computer_use | **unsupported** | n/a | `HTTP 400: Unsupported tool type: 'computer'` |
| SAM 3.1 | image_text ("red rectangle") | ok, correct | 2.4 s | IoU ≥ 0.7, confidence 0.93, lossless mask 120×200 |
| | video_text / video_box / video_point | ok, correct | 5.1 / 6.4 / 7.3 s | 50 of 50 frames tracked (IoU ≥ 0.7); first frame streams after 2–4 s |
| Voice Transcribe | file (WAV) | ok, correct | 2.7 s | "apply the code SAVE10 and the order total should drop to $45."; `turns` empty |
| | realtime (WebSocket) | ok, correct | 0.35 s | endStream → final transcript; events: `audioProgress`, `transcript` |
| Muse Code | api_model | **unsupported** | n/a | no model id; the Model API lists Spark 1.1–1.3 (+ contributor), Wonder, SAM 3.1, Image, Transcribe |
| | cli_headless | ok, correct | 24 s | `muse exec --json` (1.4.14, macOS) wrote `probe.txt = OK`, exit 0; JSONL records carry `payload_type` (e.g. `runtime.command.accepted`) |
| Spark Open | all 5 checks | pending | | waiting for Baseten or Fireworks credits (both requested) |

Rate limits match the docs: `x-ratelimit-limit-requests: 3000`, `x-ratelimit-limit-tokens: 4000000`.

### Decisions

1. **Judge video goes inline as an MP4 data URL (`video_url`, Chat Completions).**
   - *Why:* Spark 1.3 read the 5 s clip correctly at 2.9 s p50 with no upload step, and repeats hit the prompt cache.
   - *Alternatives:* The Files API path also works (`input_video` + `file_id`), but costs a 2.7 s upload and 5.5 s per call. Keep it for clips too large to inline; the size limit is unpublished, so measure it in T0.3. Frames mode (ARCHITECTURE §14) is no longer needed for Spark 1.3; it stays as the Spark Open fallback (R2).
2. **The vision fallback (§20.5) runs on Spark 1.3 computer use, not Wonder.**
   - *Why:* The live API rejects the documented `{"type":"computer"}` tool for `muse-wonder-1.0` but accepts it for `muse-spark-1.3`, which clicked inside the target in 2 turns. The docs also say Spark runs this loop more cheaply.
   - *Alternatives:* Wait for Wonder support (re-probe before P3), or have Wonder pick coordinates from a screenshot in plain text (no tool). Wonder stays the text-outline navigator; its text calls work.
3. **SAM 3.1 is the evidence model, as designed (§23).**
   - *Why:* Concept, box and point prompts all tracked the target in every frame, with confidence scores and lossless masks, in 5–7 s per 50-frame call.
   - *Alternatives:* DOM box tracks only (no model). They stay the cheap path for DOM targets.
   - *Budget:* each video call bills at least 50 frames ($0.01).
4. **Spoken intent uses the file transcription endpoint. Timestamps (`sourceMediaAt`) come from Spark watching the PM video.**
   - *Why:* Both modes transcribe accurately, but neither returns word or turn timings: `turns` is empty in `PUSH_TO_TALK`, and the realtime stream sends only `audioProgress` and `transcript` events. The file endpoint is simpler and needs no real-time pacing.
   - *Alternatives:* Realtime for live notes (0.35 s to finalize); `DIARIZATION` mode, untested.
5. **Muse Code runs in muse-fixer as a headless CLI; the coverage check uses Spark 1.3.**
   - *Why:* The Model API lists no Muse Code model (it's a product), but `muse exec --json` completed a file-writing task headless in 24 s with `META_API_KEY` alone. That takes the "CLI only" branch of the ARCHITECTURE §4 decision tree: Muse Code works where a repo checkout exists (muse-fixer: the fix and a proposed test), and coverage moves to Spark 1.3. The worker never gets a checkout.
   - *Next:* T5.3 checks the CLI on a Linux Actions runner (the docs say its sandbox needs bubblewrap) and parses the `payload_type` JSONL stream.
6. **Spark Open stays the primary judge; we wait for its credits.**
   - *Why:* It's the design (open weights, self-hostable, the Best Open Weight angle), and the credits are requested from both Baseten and Fireworks. The probe already takes either host (`SPARK_OPEN_BASE_URL` + `SPARK_OPEN_API_KEY`).
   - *Fallback, not adopted:* Wonder read the judge clip correctly (4.6 s, about $0.01 a call). If no Spark Open host exists by P4, the two judges can be Spark 1.3 + Wonder (different models, same Meta key) until it does.
7. **Probe frugally, and watch reasoning tokens.**
   - *Why:* On the video question, 1,227 of Spark's 1,247 output tokens were reasoning. Spark at 5 calls per check (25 calls) cost about $0.09. Probes now default to one call per check (`PROBE_SAMPLES` raises it).
   - *Next:* T0.3 should test a lower reasoning effort for the judge if accuracy holds.

### Moved to T0.2b (#64)
- `spark-open/*` (5 checks): done; see the T0.2b entry above.
