# Intenzo: Build Roadmap

> Task-by-task, phase-by-phase plan from **Thu Oct 29** to submission on **Wed Nov 4, 9:00 PM ET** (target: submit by 6 PM ET).
> Design reference: [`ARCHITECTURE.md`](./ARCHITECTURE.md). Section references (§) point there.

## How to use this file

- Every task has:
  - **Build:** what to make
  - **Tests:** the automated tests written *with* the task
  - **Verify:** the command or manual check run right after the task
  - **Done when:** the exit condition
- A task is checked off only when its tests pass **and** the verify step has been run and its output looked at.
- Every phase ends with a **phase gate**, an end-to-end check of everything built so far (earlier phases included). **Don't start the next phase until the gate passes.** If a gate fails, fix the problem first or use the cut list (bottom of this file).
- Every phase lists **what we have after it**, so it's always clear what's demoable.
- Commit after every task: `git commit -m "T2.4: outbox drainer with SKIP LOCKED"`.

## Test layers and commands

| Layer | Tool | Command | Runs against |
|---|---|---|---|
| Unit | Vitest | `pnpm test` | pure functions, fixtures, mocked HTTP (msw) |
| Contract | Vitest | `pnpm test:contract` | model prompt/schema fixtures; the pinned Playwright internal API |
| Browser | Vitest + Playwright | `pnpm test:browser` | local demo-shop: base on `:3000` (main), PR on `:3001` (branch worktree) |
| Live model | Vitest (tagged `@live`) | `pnpm test:live` | real Meta API / Baseten (costs credits; run on purpose) |
| End-to-end | script | `pnpm test:e2e` | a real PR on `demo-shop` through GitHub → Cloud → Modal |
| Phase gate | script | `pnpm gate:p<N>` | everything a phase promises, plus all earlier gates |

- **Regression rule:** every gate script runs `pnpm test && pnpm test:contract && pnpm test:browser` first. Gates from Phase 2 on also run the previous phase's gate.

## Milestones at a glance

| Phase | When | Outcome |
|---|---|---|
| P0 Foundations and day-1 unknowns | Thu Oct 29 | Repo, CI and the demo app exist. We know what every Meta model can actually do, and every fallback is decided |
| P1 Evidence engine (local) | Fri Oct 30 AM | Trustworthy recordings and readings of the demo bug, locally, from a hand-written path |
| P2 Hosted walking skeleton | Fri Oct 30 PM | A real PR gets an Intenzo comment with a real video, through GitHub → Cloud → Modal |
| P3 Navigator | Sat Oct 31 AM | Intenzo finds its own way to each feature; no hand-written paths |
| P4 Intent and judging | Sat Oct 31 PM | Real verdicts from a PM video ticket; the comment matches the golden file |
| P5 Evidence, fix loop, approval | Sun Nov 1 | The full demo flow: fail → GIF → Send to agent → fix → pass → PM approve |
| P6 IntentBench | Mon Nov 2 | Held-out benchmark numbers and charts |
| P7 Hardening and demo | Tue Nov 3 | Three clean demo runs in a row, README, landing page, backup take |
| P8 Submission | Wed Nov 4 | Submitted |

---

# Phase 0: Foundations and day-1 unknowns (Thu Oct 29)

**Goal:** remove every unknown that could invalidate the design before writing pipeline code, and stand up the repo and the demo target.

### T0.1 Repo scaffold
- [ ] **Build:**
  - pnpm workspace (`packages/core`, `apps/worker`, `apps/cloud`, `agents/muse-fixer`, `bench/`)
  - Node 24, TS strict, ESM, Vitest, ESLint + Prettier
  - Playwright pinned to an exact version (no caret)
  - GitHub Actions CI: typecheck, lint, unit
- [ ] **Tests:** one sample unit test in `core`; CI runs on push.
- [ ] **Verify:** `pnpm install && pnpm typecheck && pnpm test` passes locally; CI is green on GitHub.
- [ ] **Done when:** a fresh clone builds and tests with no manual steps.

### T0.2 Model access and capability probes (`scripts/probe/`)
- [ ] **Build:** one small script per model. Each records the request shape, response shape, latency (p50 over 5 calls), limits and errors in `probes/results.json`:
  - **Spark 1.3:** text, image, **MP4 video** input; JSON-mode support
  - **Spark Open (Baseten `meta-models/muse-spark-open-1026`):** video vs frames; cold start time
  - **Wonder:** text call latency; computer-use request/response shape
  - **Muse Code:** is there an API model? If not, can its CLI run headless in a container or Actions runner?
  - **SAM 3.1:** text, box and point prompts on a 50-frame clip; mask format
  - **Voice Transcribe:** can a recorded file be streamed over the WebSocket? Word timestamps?
- [ ] **Tests:** `scripts/probe/assert.ts` validates that `results.json` has an entry for every model with `ok | unsupported | error` and a latency.
- [ ] **Verify:** `pnpm probe:all && pnpm probe:assert`. Read every entry.
- [ ] **Done when:** every model has a definite capability answer.

### T0.3 Judge go/no-go under the agreement rule (`scripts/gonogo/`)
- [ ] **Build:**
  - 10 hand-recorded MP4 clips of UI behavior with known ground truth: 4 correct, 4 almost-right (stale total, off-by-a-cent, wrong %, error missing), 2 ambiguous
  - for each clip: a criterion, readings JSON and a step log
  - run both judges (Spark Open + Spark 1.3) with the `judge.v1` prompt draft and apply the §22.3 combination
- [ ] **Tests:** the scoring script has unit tests (confusion matrix, inconclusive rate).
- [ ] **Verify:** `pnpm gonogo` prints per-clip results, accuracy, false-fail/false-pass counts, inconclusive rate and latency per judge.
- [ ] **Done when** the go/no-go decision is written down:
  - **GO:** accuracy ≥ 80% on decided clips, 0 false fails on correct clips, inconclusive ≤ 30% on clear clips, verdict < 60 s
  - **Fallback:** if Spark Open can't take video → frames mode for Spark Open; if inconclusive > 30% → the R13 rule

### T0.4 Platform checks
- [ ] **Build:** a throwaway test repo plus a small GitHub App:
  - (a) an App bot comment → does the `issue_comment` workflow trigger?
  - (b) capture raw Vercel `deployment_status` payloads (environment name, `environment_url`, `target_url`)
  - (c) check-run requested actions: who can click, where they appear
  - (d) `closingIssuesReferences` on a PR into the default branch
- [ ] **Tests:** none (exploratory). Save the raw payloads as fixtures in `packages/core/fixtures/github/`.
- [ ] **Verify:** fixtures committed; findings written to `docs/DECISIONS.md`.
- [ ] **Done when:** R11 and the B-7 trigger question are answered.

### T0.5 demo-shop app (separate repo `demo-shop`)
- [ ] **Build:**
  - Next.js shop: `/products`, `/cart`, a discount input, a discount **line item**, an order **total**, an **expired-code toast**, a **canvas savings chart** fed by the line items
  - test hooks `/api/test/session` and `/api/test/reset`: HMAC-signed, timestamp checked, refuse when `VERCEL_ENV === "production"`
  - Vercel project with **production branch = `release`**, so `main` and PRs get preview deployments
- [ ] **Tests:**
  - Playwright e2e of the correct flow (apply SAVE10 → line −$5.00, total $45.00, chart slice; OLD5 → toast)
  - hook unit tests: valid signature OK; bad signature 401; stale timestamp 401; production 403; each call returns a **new** user
- [ ] **Verify:** `pnpm test:e2e` in demo-shop locally and against its `main` preview URL.
- [ ] **Done when:** the `main` preview deploys and passes its e2e test.

### T0.6 Seeded demo branches
- [ ] **Build:**
  - `pr/discount-correct`
  - `pr/discount-almost-right`: the line item and chart update immediately, the **total** stays stale until reload, and the cart "Checkout" button is relabelled "Continue"
- [ ] **Tests:** a deterministic Playwright **ground-truth test** per branch that asserts the planted behavior (this is how we know the labels are right).
- [ ] **Verify:** the ground-truth tests pass on both branch previews.
- [ ] **Done when:** both branches have previews and the ground truth is proven.

### T0.7 Demo PM video ticket and golden comment
- [ ] **Build:**
  - record the 40 s narrated PM screen recording (§32) and attach it to issue #42 in demo-shop
  - write `demo/expected-comment.md`: the exact comment Intenzo should produce for the almost-right PR
- [ ] **Tests:** none yet. The golden file becomes a test fixture in P4.
- [ ] **Verify:** the video plays from the issue; the golden file covers C1–C4 + ⚠️.
- [ ] **Done when:** both are committed.

### ✅ Phase 0 gate: `pnpm gate:p0`
- CI green; `probe:assert` passes; the go/no-go result is recorded; demo-shop ground-truth tests pass on both PR previews.
- `docs/DECISIONS.md` records:
  - the judge mode per model (video or frames)
  - where Muse Code runs (worker API or muse-fixer CLI)
  - the Transcribe approach
  - which coverage model is used
  - the inconclusive rule (strict or R13)

**What we have after P0:** a repo, a deployed demo shop with a provable planted bug, a PM video ticket, a golden expected comment, and real numbers on how well Meta's models judge UI video. Every remaining "if" in the architecture has an answer.

---

# Phase 1: Evidence engine, local (Fri Oct 30, morning)

**Goal:** given a hand-written `SavedPath`, record clean, aligned, trustworthy evidence on the PR and base apps, locally.

### T1.1 Schemas (`core/schema`)
- [ ] **Build:** the zod schemas from §7 to §9 (Criterion, CriterionSet, Target, WatchTarget, Step, SavedPath, Reading, LaneResult, JudgeOutput, Verdict, WorkerEvent, VerifyJob, IntenzoConfig).
- [ ] **Tests:** valid fixtures parse; invalid ones fail with clear paths (e.g. `nth` has no default, `Step.wait ≤ 3000`, a criterion id pattern).
- [ ] **Verify:** `pnpm test -- schema`.
- [ ] **Done when:** every type used later comes from these schemas.

### T1.2 Config loader (`core/config`)
- [ ] **Build:** `.intenzo.yml` parse + defaults + validation; unknown keys are errors.
- [ ] **Tests:** the demo-shop config parses; unknown key → error naming the key; missing isolation → `none` level.
- [ ] **Verify:** `pnpm test -- config`.

### T1.3 Lane and network safety (`core/browser/lane.ts`)
- [ ] **Build:**
  - context factory: viewport, video, tracing, `serviceWorkers: "block"`
  - bypass cookie obtained up front with `maxRedirects: 0`
  - main-frame navigation allowlist
  - identity acquisition through the HMAC session hook
- [ ] **Tests (browser):**
  - a local mock server logs headers → **no bypass header ever reaches a third-party origin** or a redirect target
  - off-origin main-frame navigation is aborted, while third-party subresources still load
  - every `acquireIdentity()` call returns a different user
- [ ] **Verify:** `pnpm test:browser -- lane`.

### T1.4 Canonical clock, marker and video alignment (`core/browser/clock.ts`, `ffmpeg.ts`)
- [ ] **Build:**
  - epoch-ms stamps in Node and the page
  - the 300 ms green marker
  - ffmpeg marker detection with tolerance → `videoOffsets`
  - trace-timestamp fallback; `infra_error` if both fail
- [ ] **Tests:**
  - a synthetic page that changes color at known times → detected offset within ±50 ms
  - a marker-free video → the fallback path is used
  - both fail → `infra_error`
- [ ] **Verify:** `pnpm test:browser -- clock`. Open one video and check by eye that the burned timestamp matches the step log.

### T1.5 Readings, regions and live regions (`core/browser/readings.ts`)
- [ ] **Build:**
  - element readings (innerText + bbox)
  - region `ariaSnapshot()` + line diff
  - live-region capture (`role=alert|status|dialog`, `aria-live`, body-level portals)
  - the box poller installed with `addInitScript`
- [ ] **Tests (fixture pages):**
  - a toast in a portal shows up as `region_diff "+ alert …"`
  - a removed element → `kind=absent`
  - the box track survives a navigation
- [ ] **Verify:** `pnpm test:browser -- readings`.

### T1.6 Observation protocol (`core/browser/record.ts`)
- [ ] **Build:**
  - the §21.3 sequence: setup → PRE → trigger (`Tt`) → POST at +0/+1000/+3000 (+ `timingMs`) → offline-annotated screenshot → reload probe if `persistence`
  - `settle()` = DOM quiet for 300 ms + no pending same-origin document/XHR/fetch, capped at 2 s
- [ ] **Tests:**
  - `settle` on a page that polls every 500 ms returns in ≤ 2 s
  - `Tt` is taken before any settle
  - a reload probe only runs for `persistence: true`
- [ ] **Verify:** run the hand-written C2 path on the local almost-right branch:
  `pnpm intenzo record --path fixtures/paths/C2.json --pr http://localhost:3001 --base http://localhost:3000`
  The readings must show **$50.00 at +0 s, +1 s and +3 s, and $45.00 after reload**.

### T1.7 Video outputs (`core/browser/ffmpeg.ts`)
- [ ] **Build:**
  - `humanVideo`: 1280×720 H.264, marker cut, step captions
  - `judgeVideo`: 960×540, 4 fps, canonical timestamps burned in
  - `take-{n}` folder layout
- [ ] **Tests:** `ffprobe` checks resolution, fps, codec and duration; a second take doesn't overwrite the first.
- [ ] **Verify:** watch both videos for one criterion.

### ✅ Phase 1 gate: `pnpm gate:p1`
- Unit + browser tests green.
- Hand-written paths for C1–C4 recorded on **both** local branches (PR + base), **3 runs in a row**:
  - every reading matches the ground-truth table in `fixtures/ground-truth.json`
  - offsets valid; no `infra_error`
  - videos and annotated stills produced

**What we have after P1:** the heart of Intenzo's trustworthiness. Exact, reproducible evidence (aligned video + readings + live regions) showing the stale-total bug, from a fixed path.

---

# Phase 2: Hosted walking skeleton (Fri Oct 30, afternoon/evening)

**Goal:** the full hosted plumbing works end to end with a hard-coded path and a **stub judge**.

### T2.1 GitHub App and webhook intake (`apps/cloud`)
- [ ] **Build:**
  - create the App from the §12 manifest (permissions + events)
  - `POST /api/github/webhook` with HMAC verification, `webhook_events` insert (unique `delivery_id`), dispatch, `waitUntil(advance)`
- [ ] **Tests:** valid signature accepted; invalid → 401; a duplicate delivery is ignored (one row, one dispatch). Uses the T0.4 payload fixtures.
- [ ] **Verify:** install the App on demo-shop, open a test PR, and see the row in `webhook_events`.

### T2.2 Database and the run state machine
- [ ] **Build:** the Drizzle schema (§11) with the `pg` driver and migrations; `transition(run, inputs)` as a pure function.
- [ ] **Tests (table-driven):**
  - PR opened, then deployment
  - deployment, then PR opened
  - draft → ready without a new deployment (found by lookup)
  - a deployment for a SHA with no open PR (ignored)
  - a new SHA supersedes the active run
  - a 20-minute timeout, then a late deployment re-opens the run
- [ ] **Verify:** `pnpm test -- transition`; `pnpm db:migrate` against Neon.

### T2.3 Deployments and baseline resolution
- [ ] **Build:**
  - `deployment_status` → `deployments` upsert → SHA→PR lookup → advance
  - environment prefix match
  - merge-base lookup via the compare API + a drift walk
  - the production environment filter
- [ ] **Tests (msw-mocked GitHub):**
  - a production environment is never used
  - drift is reported
  - with no baseline the run continues with `baseUrl=null`
- [ ] **Verify:** a demo-shop PR resolves the `main` preview as its baseline (shown in the logs).

### T2.4 Outbox and drainer
- [ ] **Build:**
  - outbox rows inside `advance()`'s transaction
  - drainer with `FOR UPDATE SKIP LOCKED` + lease
  - comment coalescing (rendered at drain time, advisory lock per group)
  - check run `external_id`
  - at-most-once agent mention
- [ ] **Tests:**
  - **two drainers run concurrently** → exactly one comment POST and one check-run POST (msw counts)
  - a newer comment version supersedes an older pending one
  - a crash after the lease → re-executed after the lease expires
- [ ] **Verify:** `pnpm test -- outbox` (against a local Postgres in Docker).

### T2.5 Modal worker shim and job protocol
- [ ] **Build:**
  - `modal/app.py`: `cpu=4, memory=8192, timeout=900`; Node in its own process group; `killpg` on cancel; a `finally` block that always sends `failed`
  - `spawn`/`cancel` endpoints
  - job JWT (`exp = deadline + 5 min`)
  - `/api/worker/events` with a `(jobId, seq)` unique constraint and the **410 stale guard**
  - `/api/worker/alive`
- [ ] **Tests:**
  - a sleep job, cancelled → the process group is gone and a `failed(cancelled)` event is received
  - an event from a superseded job → 410, and the worker aborts
  - a duplicate `seq` is ignored
- [ ] **Verify:** `modal deploy`, spawn a test job, cancel it, and check the Cloud logs.

### T2.6 Artifact upload
- [ ] **Build:** two Blob stores with explicit env prefixes; `/api/worker/upload-tokens` issues a per-file token only for paths under `runs/{runId}/`.
- [ ] **Tests:** a path outside the run → 403; a second take gets a separate path.
- [ ] **Verify:** the worker uploads a video and the public URL plays.

### T2.7 Report renderer and check run (stub verdicts)
- [ ] **Build:** `core/report` (comment markdown, check-run payload) from DB state; the stub worker emits fixed verdicts plus the real P1 recordings.
- [ ] **Tests:**
  - snapshot tests of the comment for pass, fail, inconclusive and superseded
  - length cap: collapsed sections are dropped first above 65,536 characters
- [ ] **Verify:** the rendered comment looks right on GitHub.

### ✅ Phase 2 gate: `pnpm gate:p2` + manual e2e
- `gate:p1` passes, plus all P2 unit tests.
- **E2E:**
  - open a PR on demo-shop (almost-right branch) → within about 3 min a comment appears with a **real video** from Modal and a check run (stub verdicts)
  - push another commit right away → the first run is **superseded**, the comment shows only the latest run, no duplicate comments, and the old check run is `neutral`
  - repeat twice

**What we have after P2:** the riskiest integration work is done. Real GitHub events drive a real worker on Modal, results flow back safely, and the PR shows a real recording. Everything after this improves *what* the worker decides, not *how* it's wired.

---

# Phase 3: Navigator (Sat Oct 31, morning)

**Goal:** Intenzo reaches each criterion's trigger by itself and saves replayable paths.

### T3.1 Outline wrapper (`core/browser/outline.ts`)
- [ ] **Build:** `_snapshotForAI()` wrapper + pruning (banner collapse, list collapse, ~6k token cap); an `aria-ref` locator helper; the `data-iz-ref` fallback behind a flag.
- [ ] **Tests:**
  - **contract test** on a fixture page: snapshot contains `[ref=eN]`, `aria-ref=eN` resolves, iframe content is included
  - the pruning test keeps the cap
- [ ] **Verify:** `pnpm test:contract -- outline`; print the outline for demo-shop `/products`.

### T3.2 Action guard
- [ ] **Build:** `NavAction` validation; guards for same-origin `goto`, refs that exist, `deny_text`, the allowed op set.
- [ ] **Tests:** off-origin goto rejected; "Delete account" rejected; an unknown ref rejected with a useful message back to the model.
- [ ] **Verify:** `pnpm test -- guard`.

### T3.3 Durable targets
- [ ] **Build:** `durableTarget()` with the candidate order and **same-element verification** (§20.4).
- [ ] **Tests (fixture with 3 identical "Add to cart" buttons, one with a test id):**
  - the target chosen for the 2nd button replays to the **2nd** button
  - a test id is preferred when present
  - a role+name match that resolves to the wrong element is never saved
- [ ] **Verify:** `pnpm test:browser -- durable`.

### T3.4 Explore loop (Wonder)
- [ ] **Build:** `explore()` (§20.3): start route choice, Wonder `navigate.v1`, history window, budget (25 steps / 120 s), `trigger_done` → `SavedPath` with auto region + live-region watch targets; `give_up` → `setup_failed` / `trigger_absent`.
- [ ] **Tests:**
  - with a **fixture model** (scripted NavActions): happy path, give_up classification, budget exhaustion
  - `@live` against demo-shop for each of C1–C4
- [ ] **Verify:** `pnpm intenzo explore --criterion fixtures/criteria/C2.json --pr http://localhost:3001`; inspect the saved path and the step count.

### T3.5 Replay and path cache
- [ ] **Build:** replay a `SavedPath` through the recorder (P1); a step failure on a cached path → discard, explore once, re-record; a path cache per run group + intent version.
- [ ] **Tests:** a renamed button in a fixture → replay fails → re-explore succeeds → a new take is recorded.
- [ ] **Verify:** an explored path replays on **both** PR and base.

### ✅ Phase 3 gate: `pnpm gate:p3`
- `gate:p2` passes, plus all P3 tests.
- **Live:** explore succeeds for **C1–C4 on the PR preview, 3 runs in a row** with no hand-written paths. The saved paths replay on the base preview; C3's toast and C4's canvas are reachable. Explore time per criterion is logged (feeds the §27 update).

**What we have after P3:** Intenzo navigates a real app by itself from a criterion description and leaves behind replayable, verified paths. The hand-written fixtures are no longer needed.

---

# Phase 4: Intent and judging (Sat Oct 31, afternoon/evening)

**Goal:** real criteria from a PM video ticket, and real verdicts from two Meta judges, streamed into the PR comment.

### T4.1 Intent from text tickets
- [ ] **Build:** the `intent.v1` prompt + render + schema; checklist 1:1 validation (one retry); `timingMs` defaulting for "instantly"; `ticket_hash`.
- [ ] **Tests:** fixture tickets (checklist, prose, empty) → expected criteria shapes; a checklist mismatch triggers a retry; the hash doesn't change when only the diff changes.
- [ ] **Verify:** `pnpm intenzo intent --ticket fixtures/tickets/42.md`.

### T4.2 Intent from the PM video
- [ ] **Build:** ffmpeg → PCM → Voice Transcribe (the approach chosen in P0) → transcript with timings; ffmpeg → 2 fps frames/MP4 → Spark 1.3 video; `sourceQuote` + `sourceMediaAt`; `repro.startPath`.
- [ ] **Tests:** `@live` on the demo PM video → 4 criteria matching C1–C4, each with a quote and a media timestamp; `repro.startPath = /cart`.
- [ ] **Verify:** read the transcript and criteria by eye against the video.

### T4.3 Coverage
- [ ] **Build:** `coverage.v1` with the model chosen in P0 (Muse Code or Spark 1.3); deterministic Next.js route rules.
- [ ] **Tests:** route rules (`app/(shop)/cart/page.tsx → /cart`, pages router, dynamic segments); a fixture diff missing C3 → `uncovered`.
- [ ] **Verify:** coverage for the almost-right PR maps C2 to the total-calculation file.

### T4.4 Judge bundle
- [ ] **Build:** bundle assembly (§22.2); offline annotation of the Tt+1000 screenshot with sharp; step log in canonical time; base comparison; the `MediaEncoder` mode per model.
- [ ] **Tests:** snapshot of the bundle text for a fixture lane; the annotated PNG has labelled boxes at the recorded bbox coordinates.
- [ ] **Verify:** open the annotated still for C2.

### T4.5 `valueMatches` and the combination rules
- [ ] **Build:** token matching, both-judge combination (§22.3), re-record rules (§19 e), pre-judge rules (§22.1), aggregation.
- [ ] **Tests (table-driven, the most important unit tests in the repo):**
  - `5.00` vs `$45.00` → no match; `45` vs `$45.00` → match; `"This code has expired"` vs `+ alert "This code has expired"` → match; empty citation → no match
  - agree/disagree/wrong_target combinations
  - **no judge-shopping:** disagree → re-record → an agreed verdict not among the first two → inconclusive
  - agreed fail → re-record → agreed pass → `flaky`
  - `trigger_absent` can never give `pass`
  - `no_isolation` caps the verdict
- [ ] **Verify:** `pnpm test -- judge`.

### T4.6 Live judges and the judge queue
- [ ] **Build:** Spark Open + Spark 1.3 clients through `ModelPort`; recording slots (2) + judge queue (4); liveness checks.
- [ ] **Tests:** `@live` on the P1 recordings: C2 → agreed `fail` citing the +1 s reading; C1, C3, C4 → agreed `pass`.
- [ ] **Verify:** `pnpm intenzo run --local --pr :3001 --base :3000 --ticket demo/42`.

### T4.7 Streaming comment
- [ ] **Build:** `intent_ready` → criteria list; each `criterion_verdict` → re-render; `finished` → final table.
- [ ] **Tests:** renderer snapshots for each stage; the comment never shows a superseded run.
- [ ] **Verify:** watch the comment update live on a real PR.

### ✅ Phase 4 gate: `pnpm gate:p4`
- `gate:p3` passes, plus all P4 tests.
- **Golden test:** on the almost-right PR, the hosted run's comment matches `demo/expected-comment.md` (verdict per criterion, the readings line for C2) in **3 of 3 runs**.
- On the correct PR, all criteria `pass` in 3 of 3 runs (**0 false fails**).
- Inconclusive rate and time to verdict recorded; §27 updated with measured numbers.

**What we have after P4:** the core product works. A PM's video becomes criteria, Intenzo verifies them in a real browser, and two Meta models judge the video with readings checks. A real PR gets correct, streamed verdicts.

---

# Phase 5: Evidence, fix loop, approval (Sun Nov 1)

**Goal:** the complete demo story, live on a real PR.

### T5.1 Evidence GIFs (DOM targets)
- [ ] **Build:** box track → outline rendering over the evidence window → GIF (≤ 2 MB, 640 px) + still.
- [ ] **Tests:** GIF size cap logic (fps first, then width); the window is computed from `Tt` (not from the judge's `atMs`).
- [ ] **Verify:** the C2 GIF shows the total highlighted and still at $50.00 after Apply.

### T5.2 SAM 3.1 for the canvas criterion
- [ ] **Build:** frames at 10 fps padded to ≥ 50; a text-concept prompt + the region box; mask outline rendering; 20 s timeout → annotated-still fallback.
- [ ] **Tests:** the fallback path on a simulated timeout; frame padding.
- [ ] **Verify:** `@live`: the C4 GIF highlights the discount slice of the canvas chart.

### T5.3 muse-fixer reference agent (`agents/muse-fixer`)
- [ ] **Build:**
  - the workflow with all §26.4 guards: bot author, `sig`, same-repo only, concurrency group, `contents: read`
  - an App token via `actions/create-github-app-token`
  - `pnpm install --ignore-scripts`
  - a Muse Code call (per the P0 decision), patch, typecheck, push with the App token
- [ ] **Tests:**
  - a payload with a bad signature → exits without changes
  - a fork PR → exits
  - a human comment in the bot format → exits
  - a valid payload on a test branch → a commit is pushed and **CI runs on it**
- [ ] **Verify:** trigger it by hand once on a scratch PR.

### T5.4 "Send to agent" loop
- [ ] **Build:** requested actions by outcome (§26.2); `fix` → outbox `agent:{group}:{n}` with an atomic counter; `needs-human` after the max.
- [ ] **Tests:** two quick clicks → one mention; the counter increments; at the max the button is gone and the label is set.
- [ ] **Verify:** click Send to agent on the almost-right PR → the fixer runs → a new commit → a new run.

### T5.5 PM approval
- [ ] **Build:** `Approve (PM)` only on pass; a sender check (`approvers` + write access); `/intenzo approve` fallback; the commit status naming the approver.
- [ ] **Tests:** an approver → status set; a non-approver → rejected with a reply; Approve is not offered on a failed run.
- [ ] **Verify:** approve from a second GitHub account listed in `approvers`.

### T5.6 Unrequested-change detection (one route)
- [ ] **Build:** the skip rules (no baseline, base not isolated, drift > 0); aria-snapshot sequence diff on the trigger route; masks for per-lane strings; drop hunks inside criterion regions; `changes.v1` classification.
- [ ] **Tests:**
  - inserted content doesn't shift the diff
  - the ephemeral user name is masked
  - the change inside the C2 region is dropped
  - the "Checkout" → "Continue" fixture is reported
- [ ] **Verify:** the ⚠️ line appears on the almost-right PR.

### T5.7 Billing meter
- [ ] **Build:** the §16.3 rule in the same transaction; displayed in the comment footer.
- [ ] **Tests:** a run group with only `setup_failed` → not billed; the first judged run → billed once; the 6th judged run → a second unit.
- [ ] **Verify:** `pnpm test -- billing`.

### ✅ Phase 5 gate: `pnpm gate:p5` + full manual demo run
- `gate:p4` passes, plus all P5 tests.
- **Full live loop, 2 times in a row:**
  1. almost-right PR → C2 ❌ with GIF, C4 ✅ with SAM highlight, ⚠️ label change
  2. Send to agent → muse-fixer pushes a fix, and CI runs on it
  3. new run → all ✅
  4. PM approves → status green → merge allowed

**What we have after P5:** the complete demo flow, working live: fail → evidence → agent fix → re-verify → PM approval.

---

# Phase 6: IntentBench (Mon Nov 2)

**Goal:** honest, held-out numbers that show what video judging adds.

### T6.1 Cases
- [ ] **Build:**
  - 12 cases in `bench/intentbench/cases/`: 4 correct (implemented by Muse Code), 5 almost-right (hand-seeded, labelled `seeded`), 2 side-effect, 1 broken
  - each case: ticket, branch, per-criterion ground-truth labels
  - the stratified tuning (4) / held-out (8) split
- [ ] **Tests:** a deterministic Playwright ground-truth test per case **proves each label** (the same idea as T0.6); a schema check on every case file.
- [ ] **Verify:** `pnpm bench:validate` passes for all 12.

### T6.2 Record once
- [ ] **Build:** `bench/record.ts`: per case, explore + **2 PR takes** + 1 base take → a frozen evidence pack. Exploration failures are saved as `setup_failed`.
- [ ] **Tests:** the evidence pack schema; a rerun only re-records missing packs.
- [ ] **Verify:** every case has a pack; spot-check 3 videos.

### T6.3 Judge many (offline)
- [ ] **Build:** `bench/judge.ts`: arms A (diff-only), B (readings only), C (frames), D (video, dual, plus each model alone); 3 repeats; the real §19 e rule using the 2 takes. Tune on the tuning split only.
- [ ] **Tests:** arm input builders (B has no images; A has no browser data); the results JSON schema.
- [ ] **Verify:** `pnpm bench:judge --split heldout` completes; cost and time logged.

### T6.4 Analysis and charts (Python)
- [ ] **Build:** `bench/analysis/metrics.py` + `charts.py` (pandas + matplotlib):
  - accuracy, catch rate on almost-right, false-fail rate, inconclusive rate, side-effect detection, cost/PR, time/PR
  - mean ± spread
- [ ] **Tests:** `pytest bench/analysis` on a tiny hand-computed results file (metric functions are exact).
- [ ] **Verify:** the charts render and the numbers match a manual check on 2 cases.

### ✅ Phase 6 gate: `pnpm gate:p6`
- All tests green.
- Held-out results exist for all 4 arms with spread.
- Charts are in `bench/results/`.
- A results table is drafted for the README, with the small-n caveat.

**What we have after P6:** the proof slide. Measured catch and false-failure rates for diff-only vs readings vs frames vs video, on held-out cases, which is the evidence for why Meta's video models matter here.

---

# Phase 7: Hardening and demo readiness (Tue Nov 3)

**Goal:** nothing breaks on camera, and the repo explains itself.

### T7.1 Failure injection
- [ ] **Build:** a test mode for each fault: preview returns 500; model 429 storm; Baseten cold start; Modal cancel mid-run; duplicate webhooks; a deployment arriving before the PR.
- [ ] **Tests:** each fault ends in the documented state (no hangs, no duplicate comments, a correct inconclusive/error outcome).
- [ ] **Verify:** `pnpm test:faults`.

### T7.2 Pre-warm and demo scripts
- [ ] **Build:** `scripts/demo/prewarm.sh` (Baseten min replicas 1, Modal `min_containers=1`, the path cache seeded); `scripts/demo/reset.sh` (new demo PR from the almost-right branch).
- [ ] **Tests:** none.
- [ ] **Verify:** prewarm → the first run's time is within the §27 warm target.

### T7.3 Docs and landing page
- [ ] **Build:** README (problem, how it works, architecture diagram, Meta models table, benchmark results, honest limits, what was built during the hackathon); `docs/hooks.md` reference hook; a one-page landing site.
- [ ] **Tests:** links checked (`pnpm docs:links`).
- [ ] **Verify:** a fresh reader can follow the README to run `intenzo run --local`.

### T7.4 Demo rehearsal
- [ ] **Build:** run the §32 storyboard end to end and record every take; record a full **backup take**.
- [ ] **Tests:** none.
- [ ] **Verify:** timings match the storyboard beats.

### ✅ Phase 7 gate: `pnpm gate:p7`
- All gates P0–P6 still pass.
- **3 consecutive full demo runs with no manual fixes**; the backup take is saved.
- README complete.

**What we have after P7:** a stable, rehearsed demo, a documented repo and a backup recording.

---

# Phase 8: Submission (Wed Nov 4)

- [ ] Edit the 3-minute video (storyboard §32), including an honest time-lapse marker for the fix loop and sources on screen for the stats.
- [ ] **Make the repo public** (required for submission). Before that, confirm no secrets are in the history: run `gitleaks detect`.
- [ ] Submission form: repo link, video, Meta models used, track (Indie), theme (**Push the Frontier**), a "built during the hackathon" statement.
- [ ] A 30 s X clip ("an AI agent's PR caught on camera") + post; add the link to the submission.
- [ ] **Submit by 6 PM ET** (3 h buffer before the 9 PM ET deadline).

**What we have after P8:** submitted.

---

## Stretch (only when a phase finishes early)

| Item | Ref | Test when built |
|---|---|---|
| Test generation with Muse Code + one validation run | §25 | the generated spec passes on the PR preview, and fails on the almost-right branch for C2 |
| Anti-gaming held-back variant (`SAVE15`) | §26.3 | a hard-coded `SAVE10` fix is caught |
| Wonder computer-use vision fallback | §20.5 | a canvas-only button is clicked through a point target |

## Cut list (if a gate is at risk)
1. Change detection (T5.6)
2. PM approval via requested actions (keep `/intenzo approve`)
3. Bench down to 8 cases
4. Live fix loop → recorded fix loop

**Never cut:** P1 evidence engine, P2 hosted skeleton, dual-judge video verdicts, the PM video ticket, the SAM canvas criterion, held-out IntentBench.

## After the hackathon (v1 roadmap)
- Private-repo support (signed attachment URLs, the `/g/` GIF proxy, GitHub OAuth report pages)
- Self-host mode (GitHub Action, customer model endpoints, self-hosted Spark Open)
- Slack approvals; Linear/Jira tickets
- The Vercel API triggers merge-base previews automatically
- API/backend criteria (HTTP checks)
- Billing (Stripe) on the verified-PR meter
