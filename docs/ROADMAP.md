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
- Commit in small, meaningful steps using Conventional Commits (e.g. `feat(cloud): add outbox drainer with SKIP LOCKED`). The PR is titled with the task: `T2.4: Outbox and drainer`. See [CONTRIBUTING.md](../CONTRIBUTING.md).

## Test layers and commands

| Layer | Tool | Command | Runs against |
|---|---|---|---|
| Unit | Vitest | `pnpm test` | pure functions, fixtures, mocked HTTP (msw), an in-process Postgres (PGlite) |
| Contract | Vitest | `pnpm test:contract` | model prompt/schema fixtures; the pinned Playwright internal API |
| Browser | Vitest + Playwright | `pnpm test:browser` | local demo-shop: base on `:3000` (main), PR on `:3001` (branch worktree) |
| Postgres | Vitest (`*.pg.test.ts`) | `pnpm test:pg` | a real Postgres server, for concurrency PGlite can't show (CI: a `postgres:18.6` service container) |
| Live model | Vitest (`*.live.test.ts`, called `@live` below) | `pnpm test:live` | real Meta API / Baseten (costs credits; run on purpose) |
| End-to-end | script | `pnpm test:e2e` | a real PR on `demo-shop` through GitHub → Cloud → Modal |
| Phase gate | script | `pnpm gate:p<N>` | everything a phase promises, plus all earlier gates |

- **CI on every PR:** the required `check` job runs typecheck, lint, format, unit, contract, Postgres and browser tests for the whole workspace, so no PR can break earlier work. Live tests are run by hand (`pnpm test:live`) and stay out of CI for now, because they spend model credits. See [CONTRIBUTING.md §6](../CONTRIBUTING.md#6-testing-guidelines).
- **Regression rule:** every gate script runs `pnpm check:all` first. Gates from Phase 2 on also run the previous phase's gate.

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
- [x] **Build:**
  - pnpm workspace (`packages/core`, `apps/worker`, `apps/cloud`, `agents/muse-fixer`, `bench/`)
  - Node 24, TS strict, ESM, Vitest, ESLint + Prettier
  - Playwright pinned to an exact version (no caret)
  - GitHub Actions CI: typecheck, lint, unit
- [x] **Tests:** one sample unit test in `core`; CI runs on push.
- [x] **Verify:** `pnpm install && pnpm typecheck && pnpm test` passes locally; CI is green on GitHub.
- [x] **Done when:** a fresh clone builds and tests with no manual steps.

### T0.2 Model access and capability probes (`scripts/probe/`)
- [x] **Build:** one small script per model. Each records the request shape, response shape, latency (1 call by default to save credits; `PROBE_SAMPLES=5` for a p50), limits and errors in `probes/results.json`:
  - **Spark 1.3:** text, image, **MP4 video** input; JSON-mode support
  - **Spark Open (Baseten; the guide's `meta-models/muse-spark-open-1026` id doesn't exist, the real one is `meta-models/muse-spark-open`):** video vs frames; cold start time. *Probe built here; run in T0.2b.*
  - **Wonder:** text call latency; computer-use request/response shape
  - **Muse Code:** is there an API model? If not, can its CLI run headless in a container or Actions runner?
  - **SAM 3.1:** text, box and point prompts on a 50-frame clip; mask format
  - **Voice Transcribe:** can a recorded file be streamed over the WebSocket? Word timestamps?
- [x] **Tests:** `scripts/probe/assert.ts` validates that `results.json` has an entry for every model with `ok | unsupported | error` and a latency.
- [x] **Verify:** `pnpm probe:all && pnpm probe:assert spark-1.3 wonder muse-code sam-3.1 voice-transcribe`. Read every entry.
- [x] **Done when:** every Meta API model has a definite capability answer (Spark Open: T0.2b).

### T0.2b Spark Open capability probes (waiting for credits)
- [x] **Build:** put a key for a Spark Open host in `.env`: `BASETEN_API_KEY`, or `SPARK_OPEN_BASE_URL` + `SPARK_OPEN_API_KEY` (e.g. Fireworks). No code changes are expected: the T0.2 probe takes any OpenAI-compatible host.
- [x] **Tests:** none new (T0.2's unit and contract tests cover the probe).
- [x] **Verify:** `pnpm probe:all spark-open && pnpm probe:assert`. Read every entry, especially `video` vs `frames`.
- [x] **Done when:** all five Spark Open checks have a definite answer, Spark Open's judge input mode (native video or frames, R2) is in `docs/DECISIONS.md`, and the full `pnpm probe:assert` passes.

### T0.3 Judge go/no-go under the agreement rule (`scripts/gonogo/`)
- [x] **Build:**
  - 10 MP4 clips of UI behavior with known ground truth: 4 correct, 4 almost-right (stale total, off-by-a-cent, wrong %, error missing), 2 ambiguous. *Recorded reproducibly with Playwright from a local fixture shop instead of by hand; a browser test proves each planted behavior.*
  - for each clip: a criterion, readings JSON and a step log
  - run both judges (Spark Open + Spark 1.3) with the `judge.v1` prompt draft and apply the §22.3 combination
- [x] **Tests:** the scoring script has unit tests (confusion matrix, inconclusive rate).
- [x] **Verify:** `pnpm gonogo` prints per-clip results, accuracy, false-fail/false-pass counts, inconclusive rate and latency per judge.
- [x] **Done when** the go/no-go decision is written down (**GO**, DECISIONS 2026-10-30; judges run at `reasoning_effort: low`):
  - **GO:** accuracy ≥ 80% on decided clips, 0 false fails on correct clips, inconclusive ≤ 30% on clear clips, verdict < 60 s
  - **Fallback:** if Spark Open can't take video → frames mode for Spark Open; if inconclusive > 30% → the R13 rule

### T0.4 Platform checks
- [x] **Build:** a throwaway test repo plus a small GitHub App (`sumithprabhu/intenzo-t04-sandbox` + `intenzo-demo`, registered with `pnpm github-app:create`):
  - (a) an App bot comment → does the `issue_comment` workflow trigger?
  - (b) capture raw Vercel `deployment_status` payloads (environment name, `environment_url`, `target_url`)
  - (c) check-run requested actions: who can click, where they appear
  - (d) `closingIssuesReferences` on a PR into the default branch
- [x] **Tests:** none (exploratory). Save the raw payloads as fixtures in `packages/core/fixtures/github/`.
- [x] **Verify:** fixtures committed; findings written to `docs/DECISIONS.md`.
- [x] **Done when:** R11 and the B-7 trigger question are answered (DECISIONS 2026-10-30: B-7 yes; R11 resolved, but Vercel's "deployment_status Events" toggle must be on).

### T0.5 demo-shop app (separate repo `demo-shop`)
- [x] **Build:**
  - Next.js shop **without discount codes** on `main` (`sumithprabhu/demo-shop`): `/products`, `/cart`, line items, an order **total**, a body-level toast region, a **canvas savings chart** fed by the line items, and a "Checkout" button. *Discount codes are what ticket #42 asks for, so the demo PRs add them (T0.6). See DECISIONS 2026-10-30 · demo-shop.*
  - test hooks `/api/test/session` and `/api/test/reset`: HMAC-signed, timestamp checked, refuse when `VERCEL_ENV === "production"`
  - Vercel project with **production branch = `release`**, so `main` and PRs get preview deployments, and **Settings → Git → "deployment_status Events" on** (it was off on a new project in T0.4; without it GitHub never sends `deployment_status`)
- [x] **Tests:**
  - Playwright e2e of `main`'s flows: a new shopper's $50.00 cart, the chart drawn from the line items (canvas pixels), add to cart → toast, quantity and removal changes that survive a reload, checkout, and both hooks over HTTP. *The SAVE10/OLD5 e2e moves to T0.6's `pr/discount-correct`.*
  - hook unit tests: valid signature OK; bad signature 401; stale timestamp 401; production 403; each call returns a **new** user
- [x] **Verify:** `pnpm test:e2e` in demo-shop locally and against its `main` preview URL.
- [x] **Done when:** the `main` preview deploys and passes its e2e test (9/9 on `demo-shop-git-main-…vercel.app`; DECISIONS 2026-10-30 · demo-shop).

### T0.6 Seeded demo branches
- [x] **Build:** (demo-shop branches, one commit each, the same message a real implementing agent would write)
  - `pr/discount-correct`: the discount feature on `/cart` (a discount input, a discount **line item**, the total, an **expired-code toast**, and the chart's discount slice), with the Playwright e2e of the correct flow moved here from T0.5 (apply SAVE10 → line −$5.00, total $45.00, chart slice; OLD5 → toast)
  - `pr/discount-almost-right`: the line item and chart update immediately, the **total** stays stale until reload, and the cart "Checkout" button is relabelled "Continue"
- [x] **Tests:** a deterministic Playwright **ground-truth test** per branch that asserts the planted behavior (this is how we know the labels are right). *`pnpm demo:ground-truth` in this repo, so demo-shop carries no answer key (DECISIONS 2026-10-30 · Seeded demo branches).*
- [x] **Verify:** the ground-truth tests pass on both branch previews.
- [x] **Done when:** both branches have previews and the ground truth is proven (3 runs in a row on each preview).

### T0.7 Demo PM video ticket and golden comment
- [x] **Build:**
  - record the 40 s narrated PM screen recording (§32) and attach it to issue #42 in demo-shop. *The ticket is [demo-shop #5](https://github.com/sumithprabhu/demo-shop/issues/5) (#42 was illustrative). The recording (36.5 s) is made by `pnpm demo:pm-video`.*
  - write `demo/expected-comment.md`: the exact comment Intenzo should produce for the almost-right PR
- [x] **Tests:** none yet. The golden file becomes a test fixture in P4.
- [x] **Verify:** the video plays from the issue; the golden file covers C1–C4 + ⚠️.
- [x] **Done when:** both are committed.

### ✅ Phase 0 gate: `pnpm gate:p0`
- **Passed 2026-10-30**, 8 of 8 checks (DECISIONS 2026-10-30 · Phase 0 gate).
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
- [x] **Build:** the zod schemas from §7 to §9 (Criterion, CriterionSet, Target, WatchTarget, Step, SavedPath, Reading, LaneResult, JudgeOutput, Verdict, WorkerEvent, VerifyJob, IntenzoConfig).
- [x] **Tests:** valid fixtures parse; invalid ones fail with clear paths (e.g. `nth` has no default, `Step.wait ≤ 3000`, a criterion id pattern).
- [x] **Verify:** `pnpm --filter @intenzo/core test schema`.
- [x] **Done when:** every type used later comes from these schemas.

### T1.2 Config loader (`core/config`)
- [x] **Build:** `.intenzo.yml` parse + defaults + validation; unknown keys are errors.
- [x] **Tests:** the demo-shop config parses; unknown key → error naming the key; missing isolation → `none` level.
- [x] **Verify:** `pnpm --filter @intenzo/core test config`.

### T1.3 Lane and network safety (`core/browser/lane.ts`)
- [x] **Build:**
  - context factory: viewport, video, tracing, `serviceWorkers: "block"`
  - bypass cookie obtained up front with `maxRedirects: 0`
  - main-frame navigation allowlist
  - identity acquisition through the HMAC session hook
- [x] **Tests (browser):**
  - a local mock server logs headers → **no bypass header ever reaches a third-party origin** or a redirect target
  - off-origin main-frame navigation is aborted, while third-party subresources still load
  - every `acquireIdentity()` call returns a different user
- [x] **Verify:** `pnpm --filter @intenzo/core test:browser lane`.

### T1.4 Canonical clock, marker and video alignment (`core/browser/clock.ts`, `ffmpeg.ts`)
- [x] **Build:**
  - epoch-ms stamps in Node and the page
  - the 300 ms green marker
  - ffmpeg marker detection with tolerance → `videoOffsets`
  - trace-timestamp fallback; `infra_error` if both fail
- [x] **Tests:**
  - a synthetic page that changes color at known times → detected offset within ±50 ms
  - a marker-free video → the fallback path is used
  - both fail → `infra_error`
- [x] **Verify:** `pnpm --filter @intenzo/core test:browser align` (the alignment tests live in `align.browser.test.ts`). The by-eye check of the burned timestamp against the step log moves to T1.7, which burns the timestamps.

### T1.5 Readings, regions and live regions (`core/browser/readings.ts`)
- [x] **Build:**
  - element readings (innerText + bbox)
  - region `ariaSnapshot()` + line diff
  - live-region capture (`role=alert|status|dialog`, `aria-live`, body-level portals)
  - the box poller installed with `addInitScript`
- [x] **Tests (fixture pages):**
  - a toast in a portal shows up as `region_diff "+ alert …"`
  - a removed element → `kind=absent`
  - the box track survives a navigation
- [x] **Verify:** `pnpm --filter @intenzo/core test:browser readings`.

### T1.6 Observation protocol (`core/browser/record.ts`)
- [x] **Build:**
  - the §21.3 sequence: setup → PRE → trigger (`Tt`) → POST at +0/+1000/+3000 (+ `timingMs`) → offline-annotated screenshot → reload probe if `persistence`
  - `settle()` = DOM quiet for 300 ms + no pending same-origin document/XHR/fetch, capped at 2 s
  - *`recordCriterion()` in `core/browser/record.ts`, `Settler` in `settle.ts`, the annotation in `annotate.ts`; the CLI is `pnpm intenzo record` (`apps/worker`). The C2 path and criterion are in `fixtures/`.*
- [x] **Tests:**
  - `settle` on a page that polls every 500 ms returns in ≤ 2 s
  - `Tt` is taken before any settle
  - a reload probe only runs for `persistence: true`
  - *also: POST readings never early, `trigger_absent`, `setup_failed`, the take's files (`settle.browser.test.ts`, `record.browser.test.ts`)*
- [x] **Verify:** run the hand-written C2 path on the local almost-right branch:
  `pnpm intenzo record --path fixtures/paths/C2.json --pr http://localhost:3001 --base http://localhost:3000`
  The readings must show **$50.00 at +0 s, +1 s and +3 s, and $45.00 after reload**. *3 runs in a row: exactly that, alignment ok (marker) on both sides; the base (`main`, no discount codes) ends `trigger_absent`.*

### T1.7 Video outputs (`core/browser/ffmpeg.ts`)
- [x] **Build:**
  - `humanVideo`: 1280×720 H.264, marker cut, step captions
  - `judgeVideo`: 960×540, 4 fps, canonical timestamps burned in
  - `take-{n}` folder layout
- [x] **Tests:** `ffprobe` checks resolution, fps, codec and duration; a second take doesn't overwrite the first. (`video.browser.test.ts` also checks the offsets frame for frame against a red page painted at a known canonical time, and that no marker frame survives.)
- [ ] **Verify:** watch both videos for one criterion. (T1.7 checked extracted frames by eye: the step captions on `human.mp4` and the time band under the page on `judge.mp4`, on a synthetic lane. A person still has to watch both videos, ideally of a real criterion once T1.6 records one.)

### ✅ Phase 1 gate: `pnpm gate:p1`
- **Passed 2026-10-30**: C1–C4 × PR + base × 3 runs, 24 of 24 lanes match `fixtures/ground-truth.json` (#79).
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
- [x] **Build:**
  - create the App from the §12 manifest (permissions + events)
  - `POST /api/github/webhook` with HMAC verification, `webhook_events` insert (unique `delivery_id`), dispatch, `waitUntil(advance)`
  - *The App is **Intenzo Ai** (`intenzo-ai`). Its permissions and events were set by hand to exactly the manifest's, because GitHub's form lost them (DECISIONS 2026-10-31). Dispatch is deferred with Next's `after()`. The Cloud is live at https://intenzo-cloud.vercel.app.*
- [x] **Tests:** valid signature accepted; invalid → 401; a duplicate delivery is ignored (one row, one dispatch). Uses the T0.4 payload fixtures. *(`apps/cloud`: every §12 event type from the fixtures, other apps' check runs and `check_suite` dropped, 400 on a malformed delivery; the database tests run on PGlite.)*
- [x] **Verify:** install the App on demo-shop, open a test PR, and see the row in `webhook_events`. *(demo-shop#6: `pull_request.opened` and the Preview `deployment_status` for its head SHA stored and processed; GitHub's log shows 202 for every stored delivery and 200 for the ignored ones.)*

### T2.2 Database and the run state machine
- [x] **Build:** the Drizzle schema (§11) with the `pg` driver and migrations; `transition(run, inputs)` as a pure function. *(`apps/cloud/src/db/schema.ts` + migration `0001_run_tables`; `apps/cloud/src/runs/transition.ts`: `transition()` per run and `decide()` per run group, since creating, superseding and re-opening runs are group decisions.)*
- [x] **Tests (table-driven):**
  - PR opened, then deployment
  - deployment, then PR opened
  - draft → ready without a new deployment (found by lookup)
  - a deployment for a SHA with no open PR (ignored)
  - a new SHA supersedes the active run
  - a 20-minute timeout, then a late deployment re-opens the run
  - *also: a late preview after 2 h, a failed preview, the 15-minute deadline, repeated ready events, a push to a draft, a redeploy, a reopened PR, and the §22.5 conclusions; the tables' unique keys and checks run on PGlite*
- [x] **Verify:** `pnpm --filter @intenzo/cloud test transition`; `pnpm db:migrate` against Neon. *(27 tests pass; Neon has all 11 tables after 2 migrations.)*

### T2.3 Deployments and baseline resolution
- [x] **Build:**
  - `deployment_status` → `deployments` upsert → SHA→PR lookup → advance
  - environment prefix match
  - merge-base lookup via the compare API + a drift walk
  - the production environment filter
  - *Also:*
    - the `pull_request` handler that creates runs
    - `.intenzo.yml` read from the default branch
    - installation tokens for the App
    - `runs.base_drift`
    - the App's private key on Vercel (DECISIONS 2026-10-31)
- [x] **Tests (msw-mocked GitHub):**
  - a production environment is never used
  - drift is reported
  - with no baseline the run continues with `baseUrl=null`
  - *also:*
    - a preview of a commit its PR has moved past starts nothing
    - a draft's preview is found by lookup once it's ready
    - a config with problems runs nothing
    - a failure never replaces a stored success
    - first parents only
    - 84 tests in `apps/cloud`, on PGlite and msw
- [x] **Verify:** a demo-shop PR resolves the `main` preview as its baseline (shown in the logs). *(demo-shop#7: `baseline main@b6b60c7 (the merge base) at https://demo-shop-dly0m1skm-…`, `main`'s Preview, stored with drift 0.)*

### T2.4 Outbox and drainer
- [x] **Build:**
  - outbox rows inside `advance()`'s transaction
  - drainer with `FOR UPDATE SKIP LOCKED` + lease
  - comment coalescing (rendered at drain time, advisory lock per group)
  - check run `external_id`
  - at-most-once agent mention *(the mechanism; the mention itself comes with T5.4)*
  - *Also:*
    - the check run and comment executors, rendered from the database
    - a drain after each event
    - a status line per run until T2.7's report
    - the Postgres test layer
- [x] **Tests:**
  - **two drainers run concurrently** → exactly one comment POST and one check-run POST (msw counts)
  - a newer comment version supersedes an older pending one
  - a crash after the lease → re-executed after the lease expires
  - *also:*
    - backoff, then failed after 5
    - an at-most-once effect is never repeated
    - effects without an executor stay pending
    - a check run found by `external_id`
    - a comment found by its marker (a bot's only)
    - a deleted comment posted again
    - a request no fake route answers fails its test
- [x] **Verify:** `pnpm --filter @intenzo/cloud test outbox` (against a local Postgres in Docker). *(The outbox tests pass on PGlite. The two-drainer tests ran on CI's `postgres:18.6`, since this Mac has neither Docker nor Postgres. Also checked live on demo-shop#8: one `Intenzo` check run and one comment, each created once and then edited when the preview was ready. DECISIONS 2026-10-31.)*

### T2.5 Modal worker shim and job protocol
*Split in two (issue #22), so the Cloud and Node side could land while the Modal account was being set up. T2.5a's PR is "Part of #22"; T2.5b's closes it.*

#### T2.5a Job protocol (Cloud and Node worker)
- [x] **Build:**
  - job JWT (`exp = deadline + 5 min`)
  - `/api/worker/events` with a `(jobId, seq)` unique constraint and the **410 stale guard**
  - `/api/worker/alive`
  - `finished` and `failed` end the run
  - the worker's job runner and event client, with a sleep job for testing
  - *Also:* the `job_events` table, and `INTENZO_JOB_SECRET` on Vercel
- [x] **Tests:**
  - an event from a superseded job → 410, and the worker aborts
  - a duplicate `seq` is ignored
  - *also:*
    - forged, expired or `alg`-swapped tokens are refused
    - another job's event, a non-event and an over-1 MB body are refused
    - a `finished` event ends the run without cancelling its job; `failed(cancelled)` ends it cancelled
    - a 5xx is retried with the same seq
- [x] **Verify:** the worker CLI runs a sleep job against the Cloud's routes: its events are accepted, and once its run is superseded the worker aborts on 410. *(`protocol.test.ts` runs the real CLI in its own process against the routes on a local port: `started` stored, then exit 3 within one nap of the push. The deployed routes answer 401 without a token and 410 for a token whose run doesn't exist.)*

#### T2.5b Modal shim
- [x] **Build:**
  - `modal/app.py`: `cpu=4, memory=8192, timeout=900`; Node in its own process group; `killpg` on cancel; a `finally` block that always sends `failed`
  - `spawn`/`cancel` endpoints, and the outbox's spawn and cancel effects
  - the sweeper: a Modal cron → `POST /api/internal/sweep`
  - *The shim's logic is `modal/shim.py`; until T2.7 the spawned job is a 60 s placeholder sleep.*
- [x] **Tests:** a sleep job, cancelled → the process group is gone and a `failed(cancelled)` event is received.
  - *That's `modal/test_shim.py`, which runs the real worker and cancels it with a signal.*
  - *Also:*
    - a worker ignoring SIGTERM gets SIGKILL
    - leftovers in its group are stopped
    - crash and wall-clock-limit reports
    - spawn's fresh job id per attempt
    - no spawn for a run that moved on
    - cancel with nothing to cancel
    - the sweep's secret and deadlines
- [x] **Verify:** `modal deploy`, spawn a test job, cancel it, and check the Cloud logs.
  - *demo-shop#10:* its job was cancelled through Modal while current. The shim logged `cancelled by modal.exception.InputCancellation`, the Cloud stored `failed (cancelled)`, and the run and its check run ended as cancelled.
  - *demo-shop#9:* a push stopped the first job through the stale guard, and the second job ran to `finished`.
  - DECISIONS 2026-10-31.

### T2.6 Artifact upload
- [x] **Build:** two Blob stores with explicit env prefixes; `/api/worker/upload-tokens` issues a per-file token only for paths under `runs/{runId}/`.
  - *The "token" is a presigned PUT URL per file that refuses to overwrite.*
  - *`intenzo-private` (videos, traces, bundles) and `intenzo-public` (GIFs, stills) are private and public stores, reached with `PRIVATE_BLOB_READ_WRITE_TOKEN` and OIDC with `PUBLIC_BLOB_STORE_ID`.*
  - *Also: core's `takePath()`, and the worker's `uploadArtifacts()`.*
- [x] **Tests:** a path outside the run → 403; a second take gets a separate path.
  - *Also:*
    - a climb with `..`, absolute paths, empty segments and odd characters → 403
    - a video sent to the public store → 403
    - a stale job → 410
    - the signer's request, and the presigned URL's no-overwrite
    - the worker's PUTs, a 410, and Blob refusing a PUT
- [x] **Verify:** the worker uploads a video and the public URL plays.
  - *Live, with a running job's token:* the worker's `uploadArtifacts()` put a test video in the private store (1 object, 22.28 KB). A GIF's public URL served it back identical (200 `image/gif`, 48,823 bytes). A second upload onto the same take was refused ("This blob already exists"), and a path outside the run got 403.
  - *Videos are private by design (§28)*, so they play through the report page's signed URLs (T2.7), not a public URL.

### T2.7 Report renderer and check run (stub verdicts)
*Split in two (issue #24): the report from the database first, then real recordings on Modal. T2.7a's PR is "Part of #24"; T2.7b's closes it.*

#### T2.7a Report renderer, check run and report page
- [x] **Build:**
  - `core/report` (comment markdown, check-run payload) from DB state
  - the worker's `intent_ready`, `criterion_verdict` and `criterion_evidence` events stored
  - the check run's requested actions (§26.2)
  - a report page `/r/[runId]` that plays the private videos through signed URLs
  - the stub worker emits fixed verdicts
- [x] **Tests:**
  - snapshot tests of the comment for pass, fail, inconclusive and superseded
  - length cap: collapsed sections are dropped first above 65,536 characters
- [x] **Verify:** the rendered comment looks right on GitHub.
  - *Live, demo-shop#12:* in a 13 s run (from the preview being ready), the comment showed the stub's verdicts: "❌ 3/4 passed · attempt 1", C2's expected and observed text, the merge-base baseline and a report link per criterion. The check run completed as `failure` with the same table, and `/r/{runId}` answered 200. A second commit added "Earlier runs (1)" to the same comment.
  - *Found and fixed:* the check run's Details link went to the App's homepage, which has a stray period. It now opens the run's report.

#### T2.7b Real recordings from the stub worker
- [x] **Build:**
  - the Modal image gets Chromium and ffmpeg
  - the spawn effect sends a VerifyJob, with the repo's secrets (the session hook's, Vercel's bypass) stored encrypted
  - the stub worker records the P1 paths on the PR (and base) preview, uploads the videos and cites them as evidence
- [x] **Tests:** the VerifyJob payload (no secrets for forks); the secrets' encryption round-trip.
- [x] **Verify:** a demo-shop PR's comment links a real video recorded on Modal.
  - *Live, demo-shop#13:* 94 s from opening the PR (the almost-right code) to a completed check run; the run took 1 m 32 s on Modal for 8 lanes. Each criterion's row links a clip of the PR recording, the readings show C2's bug ($50.00 at +0, +1 and +3 s, $45.00 after a reload), and the report page plays all 8 videos through signed URLs.
  - *Also the P2 gate's end-to-end check:* two pushes 7 s apart superseded the first run (its check run `neutral`), and the PR kept one comment, showing the latest run.

### ✅ Phase 2 gate: `pnpm gate:p2` + manual e2e
- **Passed 2026-10-31** (#25): `pnpm gate:p2` with T2.7b's live run on demo-shop#13 as the end-to-end check. All 8 hosted lanes (C1–C4 × PR + base) match `fixtures/ground-truth.json`, the report plays their videos, and the superseded run's check run is `neutral`. The local `gate:p1` was replaced by the same ground truth scored on the hosted recordings, and the e2e ran once, not three times (DECISIONS 2026-10-31 · P2 gate).
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
- [x] **Build:** AI snapshot (`page.ariaSnapshot({ mode: "ai" })`, public since Playwright 1.64; it replaced `_snapshotForAI()`) wrapper + pruning (banner collapse, list collapse, ~6k token cap); a ref locator helper (`page.getByRef`); the `data-iz-ref` fallback behind a flag.
- [x] **Tests:**
  - **contract test** (`outline.browser.test.ts`: it needs Chromium, which CI installs only before the browser layer) on a fixture page: snapshot contains `[ref=eN]`, `aria-ref=eN` resolves, iframe content is included
  - the pruning test keeps the cap
- [x] **Verify:** `pnpm --filter @intenzo/core test:browser outline`; print the outline for demo-shop `/products`.

### T3.2 Action guard
- [x] **Build:** `NavAction` validation; guards for same-origin `goto` (resolved, so `/\\host` is caught), refs that exist and resolve to one element, `deny_text` (whole words or phrases, case-insensitive), `fill`/`select` on the right kind of element.
- [x] **Tests:** off-origin goto rejected; "Delete account" rejected; an unknown ref rejected with a useful message back to the model.
- [x] **Verify:** `pnpm --filter @intenzo/core test guard`.

### T3.3 Durable targets
- [x] **Build:** `durableTarget()` with the candidate order and **same-element verification** (§20.4).
- [x] **Tests (fixture with 3 identical "Add to cart" buttons, one with a test id):**
  - the target chosen for the 2nd button replays to the **2nd** button
  - a test id is preferred when present
  - a role+name match that resolves to the wrong element is never saved
- [x] **Verify:** `pnpm --filter @intenzo/core test:browser durable`.

### T3.4 Explore loop (Wonder)
- [x] **Build:** `explore()` (§20.3): start route choice, Wonder `navigate.v1`, history window, budget (25 steps / 120 s), `trigger_done` → `SavedPath` with auto region + live-region watch targets; `give_up` → `setup_failed` / `trigger_absent`.
- [x] **Tests:**
  - with a **fixture model** (scripted NavActions): happy path, give_up classification, budget exhaustion
  - `@live` against demo-shop for each of C1–C4 (`explore.live.test.ts`, by hand)
- [x] **Verify:** `pnpm intenzo explore --criterion fixtures/criteria/C2.json --pr http://localhost:3001`; inspect the saved path and the step count.

### T3.5 Replay and path cache
- [x] **Build:** replay a `SavedPath` through the recorder (P1); a step failure on a cached path → discard, explore once, re-record; a path cache per run group + intent version (the Cloud's `saved_paths`, filled by `path_saved` and sent back as `cachedPaths`).
- [x] **Tests:** a renamed button in a fixture → replay fails → re-explore succeeds → a new take is recorded.
- [x] **Verify:** an explored path replays on **both** PR and base (`intenzo explore` C2, then `intenzo record` on :3001 and :3000: PR $50.00 at +0/+1/+3 s and $45.00 after the reload, base `trigger_absent`).

### ✅ Phase 3 gate: `pnpm gate:p3`
- **Passed 2026-10-31** (#31): `gate:p2` passed on the machine with the Cloud's settings, on `main` with P3 merged, and the live part below on demo-shop served locally. A hosted run then explored C1–C4 on Modal too (DECISIONS 2026-10-31 · P3 gate closed).
- `gate:p2` passes, plus all P3 tests. *(2026-10-31: all P3 tests pass, and `gate:p2` passed at `c2ada41`.)*
- **Live:** explore succeeds for **C1–C4 on the PR preview, 3 runs in a row** with no hand-written paths. The saved paths replay on the base preview; C3's toast and C4's canvas are reachable. Explore time per criterion is logged (feeds the §27 update). *(2026-10-31: passed, 12/12 explored and replayed, 2 steps and 5.5–7.3 s per criterion, $0.164 in all.)*

**What we have after P3:** Intenzo navigates a real app by itself from a criterion description and leaves behind replayable, verified paths. The hand-written fixtures are no longer needed.

---

# Phase 4: Intent and judging (Sat Oct 31, afternoon/evening)

**Goal:** real criteria from a PM video ticket, and real verdicts from two Meta judges, streamed into the PR comment.

### T4.1 Intent from text tickets
- [x] **Build:** the `intent.v1` prompt + render + schema; checklist 1:1 validation (one retry); `timingMs` defaulting for "instantly"; `ticket_hash`.
- [x] **Tests:** fixture tickets (checklist, prose, empty) → expected criteria shapes; a checklist mismatch triggers a retry; the hash doesn't change when only the diff changes.
- [x] **Verify:** `pnpm intenzo intent --ticket fixtures/tickets/42.md`.
  - *Live, Spark 1.3:* 4 criteria, one per checklist item, matching C1–C4: C2 "the order total changes from $50.00 to $45.00", within 1000 ms, surviving a reload; C3 copy "This code has expired"; C4 `ui_visual`; `repro.startPath` /cart. One call, 952 input and 4,020 output tokens (3,455 reasoning), $0.018.

### T4.2 Intent from the PM video
- [x] **Build:** ffmpeg → PCM → Voice Transcribe (the approach chosen in P0) → transcript with timings; ffmpeg → 2 fps frames/MP4 → Spark 1.3 video; `sourceQuote` + `sourceMediaAt`; `repro.startPath`.
- [x] **Tests:** `@live` on the demo PM video → 4 criteria matching C1–C4, each with a quote and a media timestamp; `repro.startPath = /cart`.
- [x] **Verify:** read the transcript and criteria by eye against the video.
  - *Live:* the transcript reads the narration word for word (the code as "save 10"). The four criteria are the demo's: the total ($50.00 → $45.00, right away), the line ("SAVE10 −$5.00"), the expired code ("This code has expired") and the chart, each quoting the PM. Their times are in the PM's order but 3–4.6 s late, and the total comes first, so it's C1 (DECISIONS 2026-10-31 · Intent from the PM video).

### T4.3 Coverage
- [x] **Build:** `coverage.v1` with the model chosen in P0 (Muse Code or Spark 1.3); deterministic Next.js route rules.
- [x] **Tests:** route rules (`app/(shop)/cart/page.tsx → /cart`, pages router, dynamic segments); a fixture diff missing C3 → `uncovered`.
- [x] **Verify:** coverage for the almost-right PR maps C2 to the total-calculation file.
  - *Live, Spark 1.3, on the almost-right PR's 13 changed files:* C2 → `components/CartView.tsx`, `lib/cart.ts` (`priceCart`, the total) and three more; C4 → `components/SavingsChart.tsx` first; every criterion `covered`; routes `/cart`. One call, $0.016.

### T4.4 Judge bundle
- [x] **Build:** bundle assembly (§22.2); offline annotation of the Tt+1000 screenshot with sharp; step log in canonical time; base comparison; the `MediaEncoder` mode per model.
  - *The annotation was already built in T1.6 with Chromium (no sharp), and both judges take native video, so the frames mode isn't built (DECISIONS 2026-10-31 · Judge bundle).*
- [x] **Tests:** snapshot of the bundle text for a fixture lane; the annotated PNG has labelled boxes at the recorded bbox coordinates.
  - *The PNG's boxes are T1.6's tests (`browser/annotate.test.ts`, `record.browser.test.ts`).*
- [x] **Verify:** open the annotated still for C2.
  - *Live, on the almost-right preview:* the still at Tt+1000 shows the "Discount (SAVE10) −$5.00" line and the boxed order total still at **$50.00**, with the order summary region labelled. The bundle built from that lane and main's carries 15 PR readings and "the trigger control isn't there at step 2" for the base.

### T4.5 `valueMatches` and the combination rules
- [ ] **Build:** token matching, both-judge combination (§22.3), re-record rules (§19 e), pre-judge rules (§22.1), aggregation.
- [ ] **Tests (table-driven, the most important unit tests in the repo):**
  - `5.00` vs `$45.00` → no match; `45` vs `$45.00` → match; `"This code has expired"` vs `+ alert "This code has expired"` → match; empty citation → no match
  - agree/disagree/wrong_target combinations
  - **no judge-shopping:** disagree → re-record → an agreed verdict not among the first two → inconclusive
  - agreed fail → re-record → agreed pass → `flaky`
  - `trigger_absent` can never give `pass`
  - `no_isolation` caps the verdict
- [ ] **Verify:** `pnpm --filter @intenzo/core test judge`.

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
- [ ] **Verify:** `pnpm --filter @intenzo/cloud test billing`.

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
- [ ] **Tests:** `pytest bench/analysis` on a tiny hand-computed results file (metric functions are exact). Add a pytest step to `.github/workflows/ci.yml` so these run on every PR.
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
- [ ] **Build:** `scripts/demo/prewarm.sh` (Modal `min_containers=1`, the path cache seeded; Baseten Model APIs need no pre-warming, T0.2b); `scripts/demo/reset.sh` (new demo PR from the almost-right branch).
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
