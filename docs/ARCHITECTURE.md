# Intenzo: Architecture

> **Intenzo** verifies that a pull request does what its ticket asked. It drives the PR's preview deployment in a real browser, records each acceptance criterion on video, judges the recording against the intent with Meta's video models, and posts the evidence to the PR.

| | |
|---|---|
| Status | **v0.3**, Thu Oct 29 2026 (revised after design reviews 1 and 2; see §0 and §0b) |
| Deadline | Meta Global AI Developer Hackathon, submission Wed Nov 4, 9:00 PM ET |
| License | Apache 2.0 |
| Languages | TypeScript (product), Python (Modal shim + benchmark analysis only) |
| Delivery | Hosted GitHub App. Self-host mode (GitHub Action) is on the roadmap, **not built for the hackathon** |

The document has four parts:
- **Part I, System architecture:** components, where they run, and how they talk.
- **Part II, Code architecture:** repo layout, modules, schemas, data model, and the GitHub App manifest.
- **Part III, Workflow architecture:** state machines, event handling, the agent loop, recording, judging, evidence and reporting.
- **Part IV:** security, observability, testing and the benchmark, the demo storyboard, the build plan and risks.

---

## 0. Changes since v0.1 (review-1 resolutions)

| # | Finding | Resolution | Where |
|---|---|---|---|
| 1 | Baseline pointed at production; the diff ran backwards | The baseline is a **non-production deployment of the merge-base SHA**. `production` is removed. In demo-shop, `main` deploys as a preview | §10, §17.3, §29 |
| 2 | Missing-element bugs collapsed to `inconclusive` | **Region watch targets** + a **region aria diff** reading. Lane failures split by phase. `trigger_absent` and unresolved post-trigger targets go to the judge | §7, §20.3, §21, §22.1 |
| 3 | Event ordering and run identity broken | A `deployments` table. Run creation looks up existing deployments. Runs keyed by UUID. Runs created only for SHAs with an open PR | §11, §16, §17 |
| 4 | Modal defaults (300 s timeout, 0.125 CPU) | `cpu=4, memory=8192, timeout=900`. The shim always reports a failure. Recording concurrency ≤ 2 per container | §3, §19 |
| 5 | `advance()` idempotency not implementable | Node-postgres/WebSocket driver for transactions. An **outbox** for every GitHub side effect. Check run `external_id`, stored comment IDs | §16.4 |
| 6 | Superseded jobs keep writing | Events from a non-current job are rejected (410). The worker checks liveness between criteria. The shim kills the Node process group | §9, §16.4 |
| 7 | Lane state contamination | **Isolation levels**; every recording gets a fresh identity. The validation replay is removed. No isolation → verdict capped at `inconclusive` | §21.1 |
| 8 | Test hooks are open session minters; secrets go to PR code | Hooks need an **HMAC signature** and refuse production. No secrets for fork PRs. The disclosure model is documented | §21.1, §29 |
| 9 | Bypass header leaked to third parties | The header is added in `context.route` **only for the preview/base origin**. The allowlist applies to main-frame navigations only | §21.2, §29 |
| 10 | Judge validity | **Both judges always**, and they must agree. A bbox-annotated screenshot input with a `wrong_target` rule. Structured `citedValue`. Evidence window from the step log | §22 |
| 11 | Navigator targeting | The outline is built from the **Chrome DevTools accessibility tree (public CDP)** with element ids. Code (not the model) turns ids into durable targets. `nth` has no default | §20 |
| 12 | Timing budget ignored the failing path | Verdicts are posted first, and evidence and tests stream into later edits. Honest timings. Pre-warming | §26, §27 |
| 13 | Decorative or misassigned Meta models | **Muse Code** does coverage, test generation and the reference fixer agent. **SAM** is used only where the DOM can't help (canvas/visual). A **PM video ticket** puts Voice Transcribe + Spark video on the critical path | §4, §18, §23, §25, §32 |
| 14 | Pixel diff false positives | Replaced with an **aria-snapshot sequence diff** on visited routes | §24 |
| 15 | Three time bases | One canonical step clock. Timestamps burned into judge frames. Marker detection checked, with a trace fallback | §21.4 |
| 16 | Observation protocol | `Tt` defined. The reload probe only runs when `persistence=true`. Optional `timing_ms` | §7, §21.3 |
| 17 | Network-idle waits | Waits for DOM quiet + no pending same-origin document/XHR requests | §20.3 |
| 18 | Intent reuse vs coverage | Intent is versioned by ticket; coverage is recomputed every run | §11, §18 |
| 19 | Billing contradictions | One rule, applied at one point | §16.3 |
| 20 | Prompt injection relayed to the coding agent | Sanitized, capped agent payload; no lane IDs | §26.3 |
| 21 | Private attachments | Signed URLs from `body_html`; known limit | §8 |
| 22 | Blob model mismatch | Per-file upload tokens; two stores (public/private) | §28 |
| 23 | App permissions and linking | Manifest section added; linking fallbacks | §12, §17.2 |
| 24 | Vercel environment name | Prefix match; raw payloads logged on day 1 | §17.1 |
| 25 | `neutral` satisfies required checks | Documented. **Check-run requested actions** replace Slack for the hackathon | §22.5, §26.2 |
| 26 | IntentBench infeasible and contaminated | **Record once, judge many.** 16 cases, 4 arms, a held-out split | §31 |
| 27 | State machine vs outcomes | Separate `state` and `outcome` (which includes `superseded`) | §16.1 |
| 28 | Unsafe defaults | Dry run is opt-in. Commands need write access | §17 |
| 29 | Path cache barely hits | Cache scoped to a run group | §19 |
| Scope | Over-engineered for 6 days | Self-host mode cut; 13 packages → 1 core package; Slack cut; walking skeleton by Friday | §5, §33 |

## 0b. Changes since v0.2 (review-2 resolutions)

| # | Finding | Resolution | Where |
|---|---|---|---|
| B-1 | The demo storyboard contradicts the system | Bug redesigned: the discount line appears, but the **total** stays stale until reload, so only C2 fails. The label change moves to `/cart`. A golden expected comment is written first | §32 |
| B-2 | No CDP → Playwright bridge | Use the **pinned internal `page._snapshotForAI()` with `aria-ref` locators**, plus a contract test. Region readings use public `locator.ariaSnapshot()`. Each durable target is checked before it is saved | §20 |
| B-3 | One `current_job_id` for two jobs | **Early IntentJob dropped.** One VerifyJob per run computes intent at step 0 and posts it | §8, §15, §19 |
| B-4 | Agent loop key and trigger | Key = `agent:{group}:{agent_attempts+1}`, incremented in the same transaction. **One trigger:** the "Send to agent" button (automatic mode is a config flag). Fixer concurrency group | §16.4, §26 |
| B-5 | Outbox has no claim | `FOR UPDATE SKIP LOCKED` + lease. Comments render at drain time and are coalesced, one per group | §16.4 |
| B-6 | Judge combination | Token-level value matching; explicit re-record rules (no judge-shopping); a **page-level live-region reading** for toasts and portals | §21.3, §22.3 |
| B-7 | Fixer is a pwn-request pattern; its pushes don't run CI | Same-repo PRs only, `--ignore-scripts`, push with an App token (`intenzo-fixer` App), concurrency group, HMAC-signed payload | §26.4 |
| B-8 | Muse Code fallback | Day-1 decision tree: API → as designed. CLI only → Muse Code lives in **muse-fixer** (fix + tests); coverage moves to Spark 1.3 | §4, R5 |
| B-9 | Who can press Approve | Checks the clicker against `approvers` + write access; Approve offered only on pass; `/intenzo approve` fallback | §26.2 |
| B-10 | Bypass leaks through redirects | Bypass cookie set once on the first same-origin document request; no headers after that; service workers blocked | §21.2 |
| B-11 | Blob path collisions | `take-{n}` in every path; tokens issued per file on request | §28 |
| B-12 | Clock details | Epoch ms everywhere; poller installed with `addInitScript`; annotations drawn offline | §21.3–21.4 |
| B-13 | Drift and onboarding | Change detection skipped when drift > 0; isolation judged per side | §17.3, §21.1, §24 |
| B-14 | Warm timing | Judging is pipelined and no longer holds a recording slot; coverage runs in parallel; honest numbers | §19, §27 |
| B-15 | Bench validity | 12 cases, stratified split, hand-seeded almost-right cases, 2 takes per PR lane, `setup_failed` reported | §31 |
| B-16 | JWT lifetime | `exp = deadline + 5 min`, refreshed through `alive` | §8 |
| B-17 | `prod_domains` is not the guard | The deployment environment filter is the authoritative check | §29 |
| B-18 | Unsourced statistics in the demo | Sources shown on screen | §32 |
| Scope | Fri/Sat overloaded | Testgen + anti-gaming → stretch; one-route change detection; days re-sliced | §33 |

---

# Part I: System architecture

## 1. Goals and non-goals

### Goals
1. For a PR linked to a ticket, give a **per-criterion verdict** (`pass` / `fail` / `inconclusive`) with **video evidence**. Target: the verdict comment in about 90 s after the preview is ready on a warm, cached run, and in 3–5 min on a first run.
2. **Low false-failure and false-pass rates.** Two independent judges must agree; otherwise the verdict is `inconclusive`.
3. **One procedure, replayed exactly** on the PR preview and the merge-base baseline, and exportable as a Playwright test.
4. Meta models do real work on the critical path:
   - **Spark 1.3:** intent from text and **video tickets**, second judge, change classification
   - **Spark Open:** primary judge
   - **Wonder:** navigation
   - **Spark 1.3 computer use:** the vision fallback (Wonder rejects the computer tool on the live API; T0.2)
   - **Muse Code:** coverage, test generation, reference fixer agent
   - **SAM 3.1:** visual/canvas evidence
   - **Voice Transcribe:** narrated tickets

### Non-goals (v0)
- **Production:** never tested, never used as the baseline, and test hooks are never called on it.
- Backend-only criteria (emails, DB rows) are marked `not_verifiable_in_ui`.
- Native mobile apps.
- General regression testing of untouched flows.
- **Self-host mode** (roadmap).

---

## 2. Component overview

```
┌──────────────────────────────── GitHub ────────────────────────────────┐
│ Issue #42 (text or PM video)   PR #128 "Fixes #42"   deployment_status │
└───────▲───────────────────────────────┬───────────────────────┬────────┘
        │ outbox drainer:               │ webhooks              │ webhooks
        │ comments, checks, statuses    ▼                       ▼
┌───────┴────────────────────── Intenzo Cloud (Vercel, Next.js) ─────────┐
│ /api/github/webhook → webhook_events → deployments / run creation      │
│ Orchestrator.advance(runId): state machine in Postgres (txn + outbox)  │
│ /api/worker/*  ← events, upload tokens, liveness (job JWT)             │
│ /r/[runId] report page · Postgres (Neon, pg driver) · Blob (2 stores)  │
└──────────┬──────────────────────────────────────────▲──────────────────┘
           │ POST modal /spawn, /cancel                │ events
           ▼                                           │
┌────────────────────────── Worker (Modal, 4 CPU / 8 GB) ────────────────┐
│ modal/app.py shim → node apps/worker/dist/main.js job.json (proc group)│
│ VerifyJob (one per run: intent → coverage → record → judge → evidence) │
│ Chromium + Playwright (pinned) · ffmpeg · no GitHub credentials        │
│        │                 │                    │                        │
│        ▼                 ▼                    ▼                        │
│  Meta Model API      Baseten             PR preview + merge-base       │
│  Spark, Wonder,      Spark Open          preview (never production)    │
│  Muse Code, SAM, ASR                                                   │
└────────────────────────────────────────────────────────────────────────┘

Reference coding agent: agents/muse-fixer (GitHub Action in the target repo, uses Muse Code)
   triggered by Intenzo's failure comment → pushes a fix → new preview → new run
```

### Responsibilities

| Component | Owns | Never does |
|---|---|---|
| **Cloud** | Webhooks, run state, all GitHub reads and writes (through the outbox), billing meter, report page, upload tokens | Runs a browser or calls video models |
| **Worker** | Intent, coverage, navigation, recording, judging, evidence, test generation | Talks to GitHub, keeps state between jobs |
| **Fixer agent** | Reading the failure and pushing a fix (stands in for any coding agent) | Being part of Intenzo's trust boundary: it is a separate client |

---

## 3. Deployment topology

| Piece | Runtime | Settings |
|---|---|---|
| Cloud | Vercel, Next.js App Router, Node 24 (Fluid Compute). Project `intenzo-cloud` (Root Directory `apps/cloud`), https://intenzo-cloud.vercel.app, deployed with the CLI (T2.1) | Function timeout 300 s (orchestration steps are short) |
| Database | Neon Postgres via Vercel Marketplace | Drizzle with the **`node-postgres` / `neon-serverless` (WebSocket) driver**, which supports interactive transactions. Not `neon-http` |
| Blob | Vercel Blob, **two stores**: `intenzo-public` (GIFs/stills for public repos) and `intenzo-private` (videos, traces, bundles) | §28 |
| Worker | Modal: `run_job` function, `spawn`/`cancel` web endpoints, cron | `cpu=4, memory=8192, timeout=900`, `min_containers=1` during demo windows |
| Sweeper | Modal cron, once a minute → `POST /api/internal/sweep` | Vercel per-minute cron needs Pro |
| Models | Meta Model API; Spark Open on Baseten **Model APIs** (shared, OpenAI-compatible, `meta-models/muse-spark-open`) | No cold start seen (first call 1.3 s, T0.2b), so no pre-warming needed |
| Demo app | `sumithprabhu/demo-shop` (private until the demo needs it public, §8), Next.js on Vercel. **Production branch = `release`**, so pushes to `main` create *preview* deployments that serve as merge-base baselines. `main` has no discount codes; the demo PRs add them (T0.5) | §17.3 |

### Modal shim behavior (`modal/app.py`)
- Starts Node with `start_new_session=True` (its own process group) and a wall-clock limit of `timeout − 30 s`.
- When Modal cancels or the limit is reached: `os.killpg(SIGTERM)`, then after 5 s `SIGKILL`.
- A `finally` block **always** POSTs a `failed` event (`infra_timeout` / `cancelled` / `crash`) unless Node already reported `finished`.
- **Built in T2.5b:**
  - The logic is in `modal/shim.py`, which `modal/app.py` calls.
  - "Already reported" means the worker's exit code (T2.5a): 0 finished, 1 failed, 3 stale. The shim reports nothing then.
  - The shim waits in one-second steps, so it notices a cancellation within a second, whether it arrives as an exception or a signal.
  - Its `failed` event uses seq 1,000,000.
  - The endpoints take a bearer secret (`MODAL_ENDPOINT_SECRET`, from the Modal Secret `intenzo-worker`).
  - The worker image never contains the repo root (`.env` files, the App's key).

---

## 4. Meta model map

| Stage | Model | Input | Output | Calls per PR (3–4 criteria) |
|---|---|---|---|---|
| Spoken intent | **Voice Transcribe** | 16 kHz WAV from the ticket's video/voice note (file endpoint) | transcript (no timings) | 1 when the ticket has media |
| Visual intent | **Spark 1.3** (video) | the PM's screen recording (≤ 2 min, 2 fps) + transcript + ticket text + images | `CriterionSet` incl. **repro steps** (start route, setup hints) | 1 |
| Coverage | **Spark 1.3** (Muse Code is CLI-only, T0.2) | criteria + PR diff | `CoverageMap` (criterion → files/hunks, candidate routes) | 1 per run |
| Navigation | **Wonder** | outline with element ids + goal + history | `NavAction` | 5–25 per new path; 0 when cached |
| Vision fallback | **Spark 1.3 computer use** (Wonder rejects the tool, T0.2) | screenshot + goal | point action | canvas/unlabeled widgets only |
| Judge A | **Spark Open** (Baseten; native MP4 video confirmed, T0.2b; `reasoning_effort: low`, T0.3) | §22.2 bundle | `JudgeOutput` (by prompt: no structured outputs on Baseten) | 1 per criterion |
| Judge B | **Spark 1.3** (`reasoning_effort: low`, T0.3) | same bundle | `JudgeOutput` (strict `json_schema`) | 1 per criterion (always) |
| Visual evidence | **SAM 3.1** | ≥ 50 frames + text concept or box | masks | 1 per `ui_visual` criterion or vision-fallback target |
| Change classification | **Spark 1.3** | aria-diff hunks + crops + criteria | `ChangeClassification[]` | 0–1 |
| Test generation (stretch) | **Muse Code**, inside muse-fixer (CLI-only, T0.2) | saved path + passing readings + criterion | Playwright spec | 1 per passing criterion |
| Fixer (reference agent) | **Muse Code** | sanitized structured failure + repo checkout | commit | per "Send to agent", ≤ 3 attempts |

**Muse Code decision tree (day 1), resolved by T0.2: CLI only.** The second branch applies: Muse Code runs in muse-fixer, and coverage uses Spark 1.3.
- **API model exists:** use it for coverage, testgen and the fixer, as in the table.
- **CLI/IDE only:** Muse Code runs where a repo checkout naturally exists, which is **muse-fixer** (the fix, plus a proposed test). Coverage moves to Spark 1.3, and the README says so. The worker never gets a repo checkout.

- Model IDs live in `core/models/registry.ts`.
- To confirm on **day 1** at dev.meta.ai:
  - exact IDs for Spark 1.3, Wonder, Muse Code, SAM 3.1 and Transcribe
  - how video is sent (upload, inline or URL)
  - **whether Muse Code is callable as an API model or only as a CLI/IDE agent** (R5)

---

# Part II: Code architecture

## 5. Repository layout

```
intenzo/                         (Apache-2.0 · pnpm workspaces · Node 24 · TS strict · ESM)
├─ LICENSE · NOTICE · README.md · docs/ARCHITECTURE.md
├─ packages/
│  └─ core/src/
│     ├─ schema/       zod schemas + types (single source of truth)
│     ├─ config/       .intenzo.yml loader + validation
│     ├─ models/       registry, Meta/Baseten/SAM/ASR clients, MediaEncoder, file cache, cost meter
│     ├─ prompts/      versioned templates: intent, coverage, navigate, judge, changes, testgen
│     ├─ intent/       ticket/video → CriterionSet; coverage
│     ├─ browser/      lanes, isolation, CDP outline, recorder, readings, clock, waits, ffmpeg
│     ├─ navigator/    explore loop, target resolution, replay, vision fallback
│     ├─ judge/        bundle assembly, dual judge, consistency rules, aggregation
│     ├─ evidence/     DOM box tracks, SAM masks, GIF/still rendering
│     ├─ changes/      aria-snapshot sequence diff + classification
│     ├─ codegen/      SavedPath → Playwright spec (Muse Code) + one validation run
│     ├─ report/       comment markdown, check-run payload, agent failure payload
│     ├─ pipeline/     runVerifyJob() (intent at step 0), recording slots + judge queue
│     └─ ports.ts      ModelPort, ArtifactStore, EventSink, Liveness
├─ apps/
│  ├─ worker/          job entry + local CLI `intenzo run --local`
│  └─ cloud/           Next.js: webhooks, orchestrator, outbox drainer, GitHub client, report page
├─ agents/
│  └─ muse-fixer/      reference coding agent (GitHub Action used by demo-shop)
├─ modal/app.py
└─ bench/intentbench/  cases/, record.ts, judge.ts, analysis/*.py (pandas reads results JSON)
```
- One `core` package with internal folders (no package-boundary tooling).
- `apps/cloud` holds the GitHub client and is the only code with GitHub credentials.

## 6. Ports (inside `core`)

```ts
export interface ModelPort    { call<T>(req: ModelRequest<T>): Promise<ModelResult<T>> }
export interface ArtifactStore { put(path: string, body: Buffer | Readable, type: string): Promise<ArtifactRef> }
export interface EventSink    { emit(e: WorkerEvent): Promise<"ok" | "stale"> }   // "stale" → abort job
export interface Liveness     { alive(): Promise<boolean> }                        // checked between criteria
```

| Port | Hosted adapter | Test / bench adapter |
|---|---|---|
| ModelPort | HTTP clients + local file cache keyed by input hash | Recorded fixtures |
| ArtifactStore | Vercel Blob with per-file client tokens from `/api/worker/upload-tokens` | tmp dir |
| EventSink | `POST /api/worker/events` (signed); a 410 response maps to `"stale"` | array |
| Liveness | `GET /api/worker/alive` (the job token names the job) | always true |

## 7. Core schemas (`core/schema`)

**Implemented in `packages/core/src/schema` (T1.1).** The code is the source of truth. It adds a few things to the sketch below:
- `ArtifactRef` (store + relative path + content type)
- `LoggedStep` (navigator steps plus the recorder's `reload` probe)
- a `trigger` flag on step-log entries (the last one is Tt)
- `LaneResult.laneStartMs` (epoch ms)
- `ContextBundle.mediaUnavailable`
- the invariants each schema enforces: absent readings have null values, pass and fail need reason `agreed`, saved paths watch a region, credentials only by secret name, and more


```ts
export const Criterion = z.object({
  id: z.string().regex(/^C\d+$/),
  text: z.string(),
  trigger: z.string(),                     // what to DO
  setup: z.array(z.string()),              // preconditions
  expected: z.string(),                    // what must be TRUE afterwards (judges only, never the navigator)
  watch: z.array(z.string()).max(3),       // things to observe, e.g. "order total", "cart form"
  kind: z.enum(["ui_behavior", "ui_visual", "copy", "not_verifiable_in_ui"]),
  persistence: z.boolean(),                // should the result survive a reload?
  timingMs: z.number().int().optional(),   // explicit timing claim ("within 500 ms"; "instantly" → 1000)
  inferred: z.boolean(),
  sourceQuote: z.string().optional(),      // exact ticket text or transcript span it came from
  sourceMediaAt: z.number().optional(),    // ms into the PM video where it was shown
});
export const ReproHints = z.object({ startPath: z.string().optional(), steps: z.array(z.string()) });
export const CriterionSet = z.object({
  criteria: z.array(Criterion).max(6),
  repro: ReproHints.optional(),            // from the PM video ticket
  intentSource: z.enum(["linked_issue", "linked_issue_video", "pr_body", "inferred"]),
  ticketHash: z.string(),                  // sha256 of normalized ticket text + media hashes (no diff)
});
export const CoverageMap = z.object({
  items: z.array(z.object({ criterionId: z.string(), files: z.array(z.string()),
                            status: z.enum(["covered", "uncovered", "unclear"]) })),
  routes: z.array(z.string()),
});

// Targets: produced by CODE from a resolved element, never typed by the model
export const Target = z.discriminatedUnion("by", [
  z.object({ by: z.literal("testId"), id: z.string() }),
  z.object({ by: z.literal("role"), role: z.string(), name: z.string(), nth: z.number().int().optional() }),
  z.object({ by: z.literal("label"), text: z.string() }),
  z.object({ by: z.literal("placeholder"), text: z.string() }),
  z.object({ by: z.literal("css"), selector: z.string() }),        // last resort, generated by code
  z.object({ by: z.literal("point"), x: z.number(), y: z.number(), viewport: z.tuple([z.number(), z.number()]) }),
]);
export const WatchTarget = z.object({
  label: z.string(),                       // "order total"
  scope: z.enum(["element", "region"]),    // region = landmark/form/dialog container
  target: Target,
});
export const Step = z.discriminatedUnion("op", [
  z.object({ op: z.literal("goto"), path: z.string() }),
  z.object({ op: z.literal("click"), target: Target }),
  z.object({ op: z.literal("fill"), target: Target, value: z.string() }),
  z.object({ op: z.literal("select"), target: Target, option: z.string() }),
  z.object({ op: z.literal("press"), key: z.string() }),
  z.object({ op: z.literal("scroll"), direction: z.enum(["up", "down"]), target: Target.optional() }),
  z.object({ op: z.literal("wait"), ms: z.number().max(3000) }),
  z.object({ op: z.literal("back") }),
]);
export const SavedPath = z.object({
  criterionId: z.string(),
  setup: z.array(Step),
  trigger: z.array(Step),                  // the last trigger step defines Tt
  watch: z.array(WatchTarget),             // always includes ≥1 region (auto-added, §20.4)
  portable: z.boolean(),                   // false if any point target
});

export const Reading = z.object({
  i: z.number(),                           // index, cited by judges
  label: z.string(),
  kind: z.enum(["text", "region_diff", "absent"]),
  phase: z.enum(["pre", "post", "after_reload"]),
  tMs: z.number(),                         // canonical clock (§21.4)
  value: z.string().nullable(),            // text, or a diff summary for region_diff
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable(),
});
export const LaneResult = z.object({
  criterionId: z.string(), side: z.enum(["pr", "base"]),
  status: z.enum([
    "completed",            // trigger executed; readings may contain nulls/absent
    "setup_failed",         // could not reach the preconditions → inconclusive
    "trigger_absent",       // setup reached, trigger control not found → judged with a confidence cap
    "precondition_unmet",   // e.g. data missing
    "timeout", "error",
  ]),
  failedStepIndex: z.number().optional(),
  tTriggerMs: z.number().nullable(),
  humanVideo: ArtifactRef.optional(), judgeVideo: ArtifactRef.optional(), trace: ArtifactRef.optional(),
  annotatedShot: ArtifactRef.optional(),   // Tt+1000 screenshot with labelled watch boxes
  stepLog: z.array(z.object({ tMs: z.number(), step: Step, ok: z.boolean(), error: z.string().optional() })),
  readings: z.array(Reading),
  boxTrack: ArtifactRef.optional(),        // rAF-sampled bbox per watch element (JSON)
  consoleErrorCount: z.number(), failedRequestCount: z.number(),
  isolation: z.enum(["ephemeral_user", "reset_hook", "none"]),
  videoOffsets: z.object({ human: z.number(), judge: z.number() }), // canonical → video ms
});

export const JudgeOutput = z.object({
  verdict: z.enum(["pass", "fail", "inconclusive"]),
  targetCorrect: z.boolean(),              // are the labelled boxes the things the criterion is about?
  citedReadings: z.array(z.number()),
  citedValue: z.string().nullable(),       // the decisive value, verbatim from a reading
  atMs: z.number().nullable(),             // canonical clock (burned into frames)
  observed: z.string(),
});
export const Verdict = z.object({
  criterionId: z.string(),
  verdict: z.enum(["pass", "fail", "inconclusive"]),
  reasonCode: z.enum(["agreed", "judges_disagree", "wrong_target", "contradicts_readings",
    "setup_failed", "precondition_unmet", "no_isolation", "flaky", "not_verifiable_in_ui", "infra_error"]),
  evidenceWindow: z.object({ startMs: z.number(), endMs: z.number() }).nullable(), // from the step log
  observed: z.string(),
  judges: z.array(JudgeOutput.extend({ model: z.string() })),
});
export const RunOutcome = z.enum(["pass", "fail", "inconclusive", "error", "cancelled", "superseded"]);
```

## 8. Job payloads

```ts
const JobBase = z.object({
  jobId: z.string().uuid(), runId: z.string().uuid(),
  deadlineAt: z.string().datetime(),
  callback: z.object({ baseUrl: z.string().url(), token: z.string() }),  // HMAC JWT, this job only,
                                                                          // exp = deadline + 5 min, refreshed via /alive
  config: IntenzoConfig,
});
// One job type. (The early IntentJob was dropped in v0.3; see §0b B-3.)
export const VerifyJob = JobBase.extend({
  type: z.literal("verify"),
  bundleUrl: z.string().url(),
  intent: CriterionSet.nullable(),          // reused intent_version for this ticket_hash, or null → compute at step 0
  prUrl: z.string().url(),
  baseUrl: z.string().url().nullable(),     // merge-base preview; null → no baseline
  baseSha: z.string().nullable(),
  secrets: z.object({                       // omitted entirely for fork PRs
    bypass: z.string().optional(),
    hookSecret: z.string().optional(),      // HMAC key for session/reset hooks
    users: z.array(z.object({ username: z.string(), password: z.string() })).optional(),
  }).nullable(),
  cachedPaths: z.array(SavedPath),          // from earlier runs in the same run group
  only: z.array(z.string()).optional(),
});
```

`ContextBundle` (written to the private store by Cloud):
```ts
{ pr: { number, title, body, headSha, baseRef, isFork, isBot },
  ticket: { source: "github_issue" | "none", ref, title, body, comments: string[] } | null,
  images: ArtifactRef[], media: ArtifactRef[],
  diff: { files: { path, status, additions, deletions, patch /* ≤ 400 lines each */ }[] },
  hints: IntenzoHints | null }
```
- **Attachments:** the ticket is fetched with `Accept: application/vnd.github.full+json`. Image and video URLs are taken from `body_html` (signed `private-user-images…?jwt=` URLs for private repos) and **downloaded immediately** in the same function (verify on day 1).
  - **Seen in T0.7, private repo:** a video's URL in `body_html` was a plain `https://github.com/user-attachments/assets/<uuid>` link, not a signed `?jwt=` URL. An authenticated GET with a user token downloaded it (302 to storage, then 200 `video/mp4`). Whether an App installation token can fetch it is untested; T4.2 must check, unless the demo repo is public by then.
- If that fails, the bundle records `media_unavailable` and the report says so. The demo repo is public, so this doesn't affect it.

## 9. Worker events

```ts
export const WorkerEvent = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("started"), jobId, seq }),
  z.object({ kind: z.literal("intent_ready"), jobId, seq, intent: CriterionSet, coverage: CoverageMap }),
  z.object({ kind: z.literal("criterion_verdict"), jobId, seq, verdict: Verdict, lanes: z.array(LaneResult) }),
  z.object({ kind: z.literal("criterion_evidence"), jobId, seq, criterionId, gif: ArtifactRef, still: ArtifactRef }),
  z.object({ kind: z.literal("path_saved"), jobId, seq, path: SavedPath }),
  z.object({ kind: z.literal("changes_done"), jobId, seq, changes: z.array(UnrequestedChange) }),
  z.object({ kind: z.literal("tests_ready"), jobId, seq, tests: z.array(GeneratedTest) }),
  z.object({ kind: z.literal("finished"), jobId, seq, outcome: RunOutcome, costUsd: z.number(), timings: z.record(z.number()) }),
  z.object({ kind: z.literal("failed"), jobId, seq, error: z.object({ code: z.string(), message: z.string() }) }),
]);
```
- `(jobId, seq)` is unique, so duplicate POSTs are ignored.
- **Stale guard:** Cloud answers **410** if `jobId ≠ runs.current_job_id` or the run is terminal. The worker treats 410 as "abort now".
- Bodies stay under 1 MB; media is always an `ArtifactRef`.

Built in T2.5a (`apps/cloud/src/jobs/`, `apps/worker/src/job/`):
- **Storage and answers:** events are stored in `job_events`. A larger body gets 413, another job's event 403, and a bad or expired token 401.
- **Ending the run:** `finished` and `failed` end it (the facts `job_finished` and `job_failed`, §16.1). A `failed` with the code `cancelled` ends it as cancelled.
- **The worker side:** events are numbered from 0, and seqs from 1,000,000 up are reserved for the Modal shim. An event the Cloud couldn't take is sent again with the same seq.
- **Exit codes:** 0 finished; 1 failed (already reported); 3 stopped on a 410. The shim reports `failed` itself only on another code.
- **Job tokens** are HS256 JWTs signed with `INTENZO_JOB_SECRET`, holding the job and run ids and `exp = deadline + 5 min`. `/alive` doesn't reissue them, since the deadline doesn't move.

## 10. Configuration (`.intenzo.yml`)

```yaml
version: 1
preview:
  provider: vercel
  environment_prefix: "Preview"        # case-insensitive prefix match (§17.1)
  project: demo-shop                   # optional suffix match for monorepos
baseline:
  mode: merge_base                     # merge_base | none
  max_drift_commits: 5                 # use nearest ancestor on base branch with a preview, within N commits
start: { default: / }
isolation:
  session_hook: /api/test/session      # POST {nonce} with HMAC → fresh ephemeral user cookies
  reset_hook: /api/test/reset          # used only when session_hook is absent
  # users: [ { username_secret: U1, password_secret: P1 } ]    # form login pool (sequential lanes)
  # form_login: { url: /login, user_label: Email, pass_label: Password }
data:
  - "valid discount code: SAVE10"
  - "expired discount code: OLD5"
guardrails:
  deny_text: ["delete account", "cancel subscription", "pay now", "place order"]
  extra_navigation_origins: []         # e.g. an auth provider
judge:
  require_agreement: true              # Spark Open + Spark 1.3 must agree for pass/fail
policy:
  run_on: [ready_for_review, preview_ready]
  inconclusive_conclusion: neutral     # neutral | failure (NOTE: neutral satisfies required checks)
  approvers: ["pm-alice", "@org/product"]   # who may press "Approve (PM)" / use /intenzo approve
  agent_handle: "@intenzo-fixer"       # omit to disable the fix loop
  agent_trigger: button                # button (default) | auto
  max_agent_attempts: 3
  allow_forks: false
tests: { export: suggest, dir: tests/intenzo }
```
- **Loader:** `packages/core/src/config` (T1.2).
  - `parseConfig()` never throws. Each problem has a path and a line, e.g. `.intenzo.yml:4: policy.auto_merge: unknown key`.
  - `readConfig()` uses the defaults when there's no file, and refuses two config files.
  - `isolationLevel()` applies §21.1: a `reset_hook` only counts with a `users` pool.
- There is no `production` baseline option. §29 refuses any URL on the project's production domain, for both the PR and base sides.
- Secrets are never in the file. They live in Cloud (encrypted).

## 11. Data model (Cloud Postgres, Drizzle, `pg` driver)

```
installations   id, gh_installation_id UNIQUE, account, created_at
repos           id, installation_id, gh_repo_id UNIQUE, full_name, default_branch, config_json,
                prod_domains TEXT[], hook_secret_enc, users_enc, bypass_enc, enabled
webhook_events  id, delivery_id UNIQUE, event, action, payload_json, received_at, processed_at, error
deployments     id, repo_id, sha, environment, url, state, gh_deployment_id, received_at,
                UNIQUE(repo_id, sha, environment)
run_groups      id, repo_id, pr_number, ticket_ref, state(open|merged|closed), comment_id,
                agent_attempts, billed_at, judged_runs, UNIQUE(repo_id, pr_number)
intent_versions id, run_group_id, ticket_hash, intent_json, UNIQUE(run_group_id, ticket_hash)
runs            id UUID, run_group_id, head_sha, attempt_no, trigger, state, outcome, outcome_reason,
                pr_url, base_url, base_sha, base_drift, intent_version_id, coverage_json,
                current_job_id, modal_call_id, check_run_id, created_at, deadline_at,
                started_at, finished_at, cost_usd, timings_json,
                UNIQUE(run_group_id, head_sha, attempt_no)
criteria_results id, run_id, criterion_id, verdict, reason_code, evidence_json, lanes_json, judges_json,
                UNIQUE(run_id, criterion_id)
saved_paths     id, run_group_id, criterion_id, intent_version_id, path_json, UNIQUE(run_group_id, criterion_id, intent_version_id)
outbox          id, run_id, group_id, effect, idem_key UNIQUE, payload_json,
                status(pending|in_flight|done|failed), lease_until, attempts, external_id, last_error, created_at
job_events      id, job_id, run_id, seq, kind, payload_json, received_at, UNIQUE(job_id, seq)
model_calls     id, run_id, stage, model, prompt_version, latency_ms, tokens_in, tokens_out,
                video_s, frames, cost_usd, cache_hit, error, created_at
```

- `webhook_events.payload_json` is the request body cast to `jsonb` in SQL, never `JSON.parse` output, so 64-bit ids keep every digit (T0.4, T2.1). `processed_at` is set when dispatch finishes; a failed dispatch leaves it null and fills `error`.
- Migrations live in `apps/cloud/drizzle/` (`pnpm db:generate`, `pnpm db:migrate`). Unit tests apply the same migrations to an in-process Postgres (PGlite).
- `runs.created_at` orders a group's runs (§16.3) and times the wait for a preview (§16.1). `runs.outcome_reason` says why a run ended without verdicts: `preview_not_ready`, `preview_failed` or `deadline_passed` (T2.2).
- CHECK constraints keep `runs.state`, `run_groups.state` and `outbox.status` to their values, and make the outcome non-null exactly when `runs.state = 'done'` (§16.1).
- `runs.base_drift` counts the commits between the merge base and `base_sha` (§17.3): 0 is the merge base itself (T2.3).
- `repos.config_json` is the validated `.intenzo.yml` from the default branch, refreshed on each PR event. `deployments` keeps one row per commit and environment, with its latest state; a failure never replaces a success (T2.3).
- `outbox.lease_until` is the end of an in-flight row's lease, or, on a pending row that failed, the time it may be tried again (T2.4).
- `job_events` holds every event a run's current job reported (§9), once per `(job_id, seq)`. A stale job's events are answered 410 and not stored (T2.5a).

## 12. GitHub App manifest

The App is **Intenzo Ai** (`intenzo-ai`, bot `intenzo-ai[bot]`), installed on demo-shop only (T2.1).

| Permission | Level | Why |
|---|---|---|
| Checks | read/write | the Intenzo check run and its requested actions |
| Pull requests | read/write | PR data, files, comments on PRs |
| Issues | read/write | linked tickets; summary comment on merge |
| Deployments | read | receive `deployment_status`; look up merge-base deployments |
| Commit statuses | read/write | `Intenzo / product approval` |
| Contents | read | `.intenzo.yml`, compare API (merge base), file → route mapping |
| Metadata | read | required |

**Events:** `installation`, `installation_repositories`, `pull_request`, `deployment_status`, `issues`, `issue_comment`, `check_run`.

`contents: write` (needed for the `/intenzo commit-tests` command) is **not requested** in v0. Tests are offered as a suggestion block instead.

### Cloud HTTP surface

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/github/webhook` | HMAC `X-Hub-Signature-256` | store event (idempotent on delivery ID; only §12 events, and only Intenzo's own check runs), then dispatch → `advance` after the response with Next's `after()` (T2.1) |
| `POST /api/worker/events` | job JWT | ingest event; **410 if stale** |
| `POST /api/worker/upload-tokens` | job JWT | per-file Blob client tokens for the job's deterministic paths |
| `GET /api/worker/alive` | job JWT | liveness for superseded/cancelled jobs |
| `POST /api/internal/sweep` | internal secret (`INTENZO_SWEEP_SECRET`) | deadlines (a `tick` for every run group with an unfinished run) and outbox retries, from Modal's cron every minute (T2.5b) |
| `GET /r/[runId]` | public for public repos (v0) | report page with chaptered player |

## 13. Prompts
- Versioned files: `intent.v1`, `coverage.v1`, `navigate.v1`, `judge.v1`, `changes.v1`, `testgen.v1`. Each has a render function and a zod output schema. The version is logged on every model call.
- All untrusted content goes in `<untrusted source="…">` blocks: ticket, transcript, PR body, diff, outline, page text, console.

## 14. Model client
- **Request:** `stage`, `model`, `promptVersion`, `messages` (text/image/video parts), `schema`, `timeoutMs`, `cacheKey`.
- **Structured output:** JSON mode if supported. On a parse failure, one retry with the zod error appended.
  - Spark 1.3 takes a strict `json_schema` (nullable fields as `anyOf`). Baseten serves Spark Open **without** structured outputs, so it's asked by prompt and its reply is extracted and zod-checked; in T0.3 it answered valid JSON 20/20 times (DECISIONS 2026-10-30).
- **Retries:** 429/5xx → backoff 0.5 s / 1.5 s / 4 s, within `timeoutMs`.
- **`MediaEncoder` modes:**
  - `video`: MP4 H.264, 960×540, 4 fps (plus a 40 px time band under the frame for judge clips, §21.4)
  - `frames`: JPEG 2 fps, timestamps burned in

  The mode comes from the registry. The day-1 go/no-go sets it per model.
- **Cache:** a local file cache keyed by input hash (used by the bench and local runs). Hosted runs don't cache judge calls.

---

# Part III: Workflow architecture

## 15. End-to-end sequence

```mermaid
sequenceDiagram
    autonumber
    participant GH as GitHub
    participant C as Cloud
    participant W as Worker (Modal)
    participant M as Models
    participant P as Previews (PR + merge-base)
    participant F as muse-fixer

    GH->>C: pull_request.opened (PR #128 Fixes #42)
    C->>C: run_group + run; outbox: check run (queued), placeholder comment
    C->>GH: (drainer) create check run, comment "waiting for preview"
    C->>C: ContextBundle → Blob; look up deployment for head sha (none yet)
    GH->>C: deployment_status success (head sha)
    C->>C: deployments row → run has PR URL → resolve merge-base preview → spawn VerifyJob
    W->>M: step 0: Transcribe + Spark 1.3 video intent (or reuse) ∥ coverage
    W->>C: intent_ready → comment "Verifying 4 criteria…"
    W->>P: explore (PR) → recorded replay PR → recorded replay base
    W->>M: Spark Open + Spark 1.3 judges (pipelined, both always)
    W->>C: criterion_verdict ×4 (comment re-rendered as each arrives)
    W->>M: SAM 3.1 (canvas criterion) · Spark 1.3 changes
    W->>C: criterion_evidence, changes_done, finished
    C->>GH: final comment, check run conclusion + requested actions [Re-run][Send to agent]
    GH->>C: check_run.requested_action "fix" (developer/PM clicks)
    C->>GH: failure comment "@intenzo-fixer …" (outbox key agent:{group}:{n})
    GH->>F: issue_comment workflow (same-repo PR only) → Muse Code fix → push with App token
    GH->>C: synchronize + deployment_status → new run …
```

## 16. State machines

### 16.1 Run (state and outcome are separate)

The machine is `apps/cloud/src/runs/transition.ts` (T2.2). `transition()` applies one step to one run. `decide()` works out what one fact (a PR action, a preview, a failed preview, the sweeper's tick) changes in a run group: runs to create, runs that change, and their effects. Both are pure; the database layer loads, decides and writes in one transaction (§16.4).

```
state:   waiting_inputs ─► verifying ─► reporting ─► done
              │                │            │
              └────────────────┴────────────┴─► done   (with outcome error | cancelled | superseded)
outcome (set when state=done): pass | fail | inconclusive | error | cancelled | superseded
```

| State | Waits for | Timeout |
|---|---|---|
| `waiting_inputs` | a successful deployment for `head_sha` | 20 min → done/inconclusive ("preview not ready"), but only if no deployment exists. A late deployment re-opens the run (§16.2) |
| `verifying` | `finished` / `failed` from the current job | `deadline_at` = 15 min → done/error |
| `reporting` | outbox effects for the final report drained | retried by the sweeper |

### 16.2 How runs get their inputs (order independent)
1. **Run creation** (PR opened/ready, synchronize, `/intenzo`, check-run re-request): insert the run, then **look up the `deployments` table** for `head_sha`. If nothing is there, call `GET /repos/{o}/{r}/deployments?sha={head_sha}` + statuses once and backfill. If found → `advance()` straight to verifying.
2. **`deployment_status`** only upserts `deployments`. Then it calls `GET /repos/{o}/{r}/commits/{sha}/pulls` to find open PRs, and `advance()`s any run waiting on that sha. **No run is ever created from a deployment.** A SHA with no open PR (any branch push) is stored and ignored.
3. A deployment arriving for a run that timed out within the last 2 h re-opens it, as attempt n+1.

Built in T2.3 (`apps/cloud/src/github/handlers.ts`, `src/runs/advance.ts`):
- `advance()` locks the group's row, decides and writes in one transaction.
- `commits/{sha}/pulls` lists every open PR that *contains* the commit. Only those whose head it is are advanced, so a preview of a commit the PR has moved past starts nothing.
- Each run that starts verifying gets its baseline (§17.3).

### 16.3 Run group and billing
- A new head SHA creates a new run (`attempt_no` resets per sha; group-wide ordering is by `created_at`). The previous non-terminal run → done/superseded:
  - `cancel` sent to Modal
  - check run closed as `neutral` ("superseded")
  - `current_job_id` cleared, so late events get 410
- **Billing rule (the only one):** a run group is billed **once, when a run first finishes with ≥ 1 criterion judged `pass` or `fail`**. `billed_at` and the usage meter are written in that same transaction.
  - Runs where every criterion is `setup_failed`, `precondition_unmet`, `not_verifiable`, `no_isolation` or `infra_error` are **never** billed.
  - Every further 5 judged runs in the same group (the first one included in the count) adds one unit.
  - Hackathon: metered and displayed only.

### 16.4 `advance()` and the outbox
```
advance(runId):
  BEGIN
    run = SELECT … FOR UPDATE
    next = transition(run, inputs)           // pure function, unit-tested
    UPDATE runs …
    INSERT outbox(effect, idem_key, payload) … ON CONFLICT (idem_key) DO NOTHING
  COMMIT
  drainOutbox()                              // also run by the sweeper every minute

drainOutbox():                               // safe to run concurrently from any function
  loop:
    row = UPDATE outbox SET status='in_flight', lease_until=now()+'60s', attempts=attempts+1
          WHERE id = (SELECT id FROM outbox
                      WHERE status='pending' OR (status='in_flight' AND lease_until < now())
                      ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1)
          RETURNING *
    if none → return
    execute(row) → status='done', external_id | on error: status='pending' (backoff) or 'failed' after 5
```
- **Comments are coalesced.** A comment effect carries only `groupId`. At drain time the comment is **rendered from the current DB state** and PATCHed. Comment effects are serialized per group with `pg_advisory_xact_lock(hash(groupId))`. If a newer pending comment effect exists for the same group, the older row is marked `done` without a call. Out-of-order versions are therefore impossible.
- **Agent mention:** at-most-once. The row is marked `done` *before* the POST. A crash in between loses a mention (the user can press "Send to agent" again) rather than starting two paid fixer runs.
Effects and their idempotency:

| Effect | `idem_key` | How it's made idempotent |
|---|---|---|
| create check run | `check:{runId}` | `external_id = runId`. Before creating, list `check-runs?check_name=Intenzo` for the sha and reuse a match |
| update check run | `check:{runId}:{version}` | PATCH by the stored ID (last write wins, versioned) |
| upsert comment | `comment:{groupId}:{seq}` | Rendered at drain time; PATCH the stored `run_groups.comment_id`; if null, search for the marker before creating; serialized per group |
| agent mention | `agent:{groupId}:{agent_attempts+1}` | `run_groups.agent_attempts` is incremented in the same transaction that inserts the row; at-most-once (see above) |
| status (product approval) | `status:{sha}:{decision}` | Statuses are idempotent by context |
| spawn job | `spawn:{runId}:{jobType}` | The `runs.current_job_id` check before spawning |

**The comment always renders the latest non-superseded run.** It's rebuilt from the DB on every update, never patched incrementally.

Built in T2.4 (`apps/cloud/src/outbox/`):
- **Where it runs:** `advance()` writes the rows in its transaction (`rows.ts`). Each webhook drains after its event (`drain.ts`). The sweeper will drain too, once the Modal cron exists (T2.5).
- **Leases and retries:** a claimed row is leased for 60 s. A failure is tried again after 10, 20, 40 and 80 s, then marked `failed`. Effects without an executor stay pending.
- **Spawn and cancel (T2.5b):**
  - Spawn gives the run a fresh `current_job_id` on every attempt, then calls Modal. A job an earlier attempt may have started is stale from then on, and stops at its next `/alive`.
  - Cancel calls Modal with the saved `modal_call_id`; with none, there's nothing to cancel.
  - Both run only once the four Modal settings are on Vercel.
  - Until T2.7 the job is a 60 s placeholder sleep.
- **The check run is rendered from the run's row, like the comment**, under an advisory lock per run. So its key is `check:{runId}:{status}` (a run passes each status once), and no version is needed: whichever drainer runs last shows the latest state.
- **The comment starts with a marker** (`<!-- intenzo:run-group:{id} -->`). One posted by a drainer that died is found by it, on a bot's comment only. A deleted comment is posted again.
- **Two drainers at once** make one check-run POST and one comment POST, on a real Postgres (`drain.pg.test.ts`). Checked live on demo-shop#8.

### 16.5 Lane (worker)
```
pending ─► identity ─► [explore (PR, unrecorded)] ─► record_pr ─► record_base ─► judged
               │              │                         │             │
               └ no_isolation  └ setup_failed /          └ setup_failed └ trigger_absent (normal for new UI)
                                 trigger_absent
```

## 17. GitHub event handling

| Event | Condition | Action |
|---|---|---|
| `installation.*` | — | Upsert installation and repos. **No automatic dry run** (opt-in from the setup page) |
| `pull_request.opened` / `reopened` / `ready_for_review` | not draft | Upsert the run group, create a run (§16.2) |
| `pull_request.synchronize` | — | Supersede, then create a run for the new sha |
| `pull_request.edited` / `issues.edited` | the linked ticket or PR body changed | Recompute `ticket_hash`. If it changed and a run is not yet verifying → refresh intent; otherwise the next run picks it up |
| `deployment_status` | `state=success`, environment matches (§17.1) | Upsert `deployments`, then advance waiting runs (§16.2) |
| `deployment_status` | failure/error for a sha with a waiting run | done/inconclusive ("preview failed to deploy") |
| `issue_comment.created` on the PR | `/intenzo …` and the **commenter has write access** (checked via the collaborator permission API) | `/intenzo` re-runs; `/intenzo rerun C2`; `/intenzo verified C2 <note>` |
| `check_run.requested_action` | our check (`check_run.app.id` is Intenzo's: the App also receives every other app's check runs, T0.4) | `approve` → product approval status, **only if `sender` ∈ `approvers` and has write access** (otherwise a reply comment explains why) **and the run's outcome is `pass`** (buttons can be pressed on runs still in progress, T0.4); `rerun`; `fix` → agent mention (if `agent_attempts < max`) |
| `issue_comment.created` | `/intenzo approve` | Same checks as the Approve button (a fallback for PMs who can't see the Checks tab) |
| `check_run.rerequested` | our check | Re-run |
| `pull_request.closed` | merged | Group → merged; summary comment on the ticket (outbox) |

### 17.1 Matching the preview deployment
- **Environment:** case-insensitive prefix `preview.environment_prefix`, plus an optional `project` substring. Vercel names them exactly `Preview` and `Production` (T0.4).
- **Production is recognized by name.** Vercel sends `production_environment: false` even on its `Production` deployments, so that flag is never trusted (T0.4).
  - An environment that starts with "prod" or says "production" is never used, whatever the prefix. The rule errs toward production.
  - It's checked before a deployment's status is read (T2.3, `apps/cloud/src/deployments/match.ts`).
- **A failure never replaces a stored success** for the same commit and environment: the earlier deployment still serves the commit. A Vercel redeploy adds a new `success` status, with a new URL, to the same GitHub deployment (T2.3).
- **URL:** `deployment_status.environment_url`, falling back to `target_url`. For Vercel both are the deployment's unique URL (`<project>-<hash>-<team>.vercel.app`), and `deployment.ref` is the commit SHA, not the branch.
- **Vercel must send `deployment_status`.** It's a per-project toggle (Settings → Git → "deployment_status Events") that was **off** on a new project in T0.4, which left only a commit status pointing at the Vercel dashboard. Onboarding has to ask for it, and Vercel's GitHub App may need a permissions update. Vercel posts only the final status (`success`; no `pending`).
- Raw payloads from T0.4 are fixtures in `packages/core/fixtures/github/` (R11 resolved).

### 17.2 Finding the ticket
1. GraphQL `closingIssuesReferences`. This only works for PRs into the **default branch**, or links made manually in the sidebar (T0.4: a PR into `develop` saying "Fixes #1" returned nothing).
2. Otherwise, a regex over the PR body and title: `(fixes|closes|resolves|refs)? #(\d+)`, `owner/repo#n`, issue URLs.
3. Otherwise `intentSource = pr_body`, and the comment says "intent taken from the PR description (unverified)".

### 17.3 Finding the baseline (merge-base preview)
1. Compare API `GET /repos/{o}/{r}/compare/{base}...{head}` → `merge_base_commit.sha`.
2. Look up a successful **non-production** deployment for that sha (in `deployments`, then the API).
3. If there's none, walk the base branch's first-parent history up to `max_drift_commits` and use the nearest ancestor with a preview. The report states the drift: "baseline = main@a1b2c3 (2 commits before the merge base)". **With drift > 0, unrequested-change detection (§24) is skipped**, because changes on main in the gap would appear as PR changes. Before/after clips are still shown, with the drift label.
4. Otherwise `baseUrl = null`. The run continues without before/after, and the report says so.
5. Any candidate URL on `repos.prod_domains` is rejected.

Built in T2.3 (`apps/cloud/src/runs/baseline.ts`), when a run starts verifying:
- The compare answer carries the merge base's parents. Each further step is one `GET /commits/{sha}`.
- The result is stored in `runs.base_url`, `base_sha` and `base_drift`.
- A failed lookup is logged, and the run goes on without a baseline.
- demo-shop#7 resolved `main@b6b60c7 (the merge base)`.

Customer note: this needs base-branch commits to have preview deployments. On Vercel, set the production branch to `release`/`prod`, or (v1) Intenzo triggers a preview of the merge base through the Vercel API.

## 18. Intent workflow

```
ContextBundle
 ├─ media (PM screen recording / voice note)
 │    ├─ ffmpeg → 16 kHz WAV → Voice Transcribe (file endpoint) → transcript (no word or turn timings, T0.2)
 │    └─ ffmpeg → 2 fps, 960 px → Spark 1.3 video input
 ├─ images → resized ≤ 1568 px
 ▼
Spark 1.3 (intent.v1): ticket text + transcript + video + images
   → CriterionSet { criteria (≤ 6; each with trigger, setup, expected, watch, kind,
                    persistence, timingMs?, sourceQuote / sourceMediaAt), repro { startPath, steps } }
   (sourceMediaAt comes from Spark watching the video: transcription returns no timings)
validation:
   - an explicit checklist in the ticket → criteria map 1:1 to its items (else one retry)
   - every criterion has a trigger, unless kind = not_verifiable_in_ui
   - "instantly" / "immediately" without a number → timingMs = 1000
▼
intent_versions (keyed by ticket_hash; reused by later runs in the group)

Coverage (every run, since it depends on the diff; runs in parallel with recording when cached paths exist):
Muse Code, or Spark 1.3 if Muse Code is CLI-only (coverage.v1): criteria + diff → CoverageMap
   + deterministic route candidates (Next.js app/ and pages/ file → route rules)
```

## 19. Verify workflow

```
VerifyJob (Modal: 4 CPU, 8 GB, timeout 900 s; Node limit 870 s)
 0. intent = job.intent ?? runIntent(bundle) → emit intent_ready (comment lists the criteria)
    coverage = coverage.v1   (awaited before exploring; in parallel with recording when every path is cached)
 1. Preflight: GET prUrl / baseUrl through the route handler (§21.2); 2xx/3xx, else error "preview unreachable"
 2. Isolation check per side (§21.1)
 3. RECORDING SLOTS (2 at a time, CPU budget). For each criterion (kind ≠ not_verifiable_in_ui):
      a. path = cachedPaths[criterion] (same run group + intent version) ?? explore(PR)      §20
         explore is unrecorded, with its own fresh identity
      b. record PR take 1 (fresh identity) → LaneResult(pr)                                    §21
         a step fails on a cached path → discard the path, explore once, record again (take 2)
      c. record base (fresh identity) → LaneResult(base)   (trigger_absent is normal for new UI)
      d. hand off to the JUDGE QUEUE and free the slot
    JUDGE QUEUE (separate concurrency, 4): both judges in parallel → first result R1   §22
      e. re-record rule (at most one re-record per criterion; a fresh take uses a recording slot):
         R1 = agreed fail   → re-record PR → R2; final = fail only if R2 = agreed fail, else inconclusive(flaky)
         R1 = disagreement  → re-record PR → R2; final = R2 only if R2 is agreed AND R2 ∈ {A1, B1}
                              (one of the first two individual verdicts), else inconclusive(judges_disagree)
         R1 = agreed pass / other → final = R1
      f. emit criterion_verdict → Cloud re-renders the comment
      g. liveness check; stale → abort
 4. After all verdicts, in parallel: evidence (§23) → criterion_evidence; changes (§24) → changes_done;
    [stretch] testgen (§25) → tests_ready
 5. emit finished(outcome, cost, timings)
```

## 20. Navigator: the exploration loop

### 20.1 The outline (pinned Playwright AI snapshot)
- Playwright is pinned to an **exact version** in `package.json` (no caret). The outline comes from Playwright's internal `page._snapshotForAI()`, the same snapshot Playwright MCP uses. It is aria-snapshot YAML in which every node carries `[ref=eN]`, the names are computed by **Playwright's own accessible-name logic** (so they match `getByRole`), and iframes are included.
- Acting on a ref uses `page.locator("aria-ref=e12")`: a real Playwright locator, with actionability waits.
- **Contract test** (`browser/snapshot.contract.test.ts`): runs against a fixture page and fails CI if the API, ref format or locator engine changes. It's the only place that touches the internal API, wrapped in `browser/outline.ts`.
- **Fallback if the internal API breaks:** a single `page.evaluate` pass that tags outlined nodes with `data-iz-ref="eN"` (the `settle` observer ignores that attribute) and uses `locator('[data-iz-ref="eN"]')`.
- Pruning (done in our wrapper):
  - banner/navigation collapsed after turn 1 unless the model asks to expand it
  - lists with > 8 similar items → first 8 + "(+N more)"
  - cap of about 6k tokens
```
<untrusted source="page_outline" url="/products">
- banner [ref=e3] (collapsed: link "Shop", link "Cart (0)")
- heading "Products" [ref=e7]
- listitem [ref=e9]:
  - link "Blue Mug" [ref=e10]  - text "$50.00"  - button "Add to cart" [ref=e12]
- listitem [ref=e14]:
  - link "Red Pen" [ref=e15]   - text "$3.00"   - button "Add to cart" [ref=e17]
</untrusted>
```

### 20.2 The model's output (`NavAction`)
```json
{"thought":"Need an item ≥ $50 in the cart",
 "phase":"setup",
 "action":{"op":"click","ref":"e12"},
 "status":"continue"}
```
- `ops`: `goto(path)`, `click(ref)`, `fill(ref, value)`, `select(ref, option)`, `press(key)`, `scroll(dir, ref?)`, `wait(ms ≤ 3000)`, `back`.
- `status`:
  - `continue`
  - `trigger_done` (the action just taken *was* the trigger). Requires `watch: [{label, ref}]`
  - `give_up` with a reason: `precondition_unmet` | `trigger_not_found` | `blocked`
- **The model only ever returns ids from the current outline.** It never writes selectors or counts.

### 20.3 Loop
```
explore(criterion, lane):
  identity = acquireIdentity(lane)                          // §21.1, never done by the model
  goto(intent.repro.startPath ?? bestRoute(coverage.routes, criterion) ?? start.default)
  for step in 1..25 (and ≤ 120 s):
    outline = buildOutline(page)
    a = Wonder(navigate.v1, {criterion.trigger, criterion.setup, criterion.watch, data, repro.steps,
                             outline, history(last 6), lastResult})      // `expected` NOT included
    if a.status == give_up:
        return a.reason == trigger_not_found && setupDone(history) ? TriggerAbsent(screens) : SetupFailed(a.reason)
    guard(a):  goto same-origin (or extra_navigation_origins); ref exists; element text ∉ deny_text
    el = page.locator(`aria-ref=${a.action.ref}`)           // must resolve to exactly 1 element
    if !el and failures ≥ 2 → visionFallback (§20.5)
    execute(a.action, el); await settle(page)               // §20.3.1
    history.push(a, result, durableTarget(el))
    if a.status == trigger_done: return buildSavedPath(history, a.watch)   // §20.4
  return SetupFailed("budget")
```

#### 20.3.1 `settle(page)`
Wait until **both** conditions hold, capped at 2 s:
- no DOM mutations for 300 ms (a `MutationObserver` injected through `addInitScript`)
- no pending `document`/`xhr`/`fetch` requests **to the preview origin**

Third-party requests, WebSockets, EventSource and beacons are ignored, and so are Intenzo's own DOM writes (the sync marker, `data-iz-ref` ids). The quiet window never starts before the call: an action's effects can reach Node a moment after the action resolves (T1.6).

### 20.4 From element ids to durable targets (code, not model)
```
durableTarget(el):                     // el = the aria-ref locator the model chose
  for candidate in [testId, role+name, label, placeholder, role+name+nth, css]:
     loc = toLocator(candidate)
     if await loc.count() == 1 && await isSameElement(loc, el) → return candidate
  → return css (shortest unique path; verified the same way)
isSameElement(a, b) = a.evaluate((x, y) => x === y, await b.elementHandle())
```
- Each candidate is **verified to resolve to exactly the chosen element** before it's saved, so a target can never silently point at a different "Add to cart".
- `buildSavedPath` **auto-adds two region watch targets:**
  1. the nearest ancestor of the trigger element that is a `form`, `dialog`, `region` or landmark (else `main`)
  2. the page-level **live regions** (§21.3)

  So a region reading always exists, even when the element the criterion is about never appears, or appears in a toast or portal.

### 20.5 Vision fallback (Spark 1.3 computer use)
- T0.2: the live API rejects the `computer` tool for `muse-wonder-1.0` but accepts it for `muse-spark-1.3`, which clicked inside the probe's Apply button in 2 turns (screenshot, then click). The loop is the documented Responses-API one (`computer_call` → `computer_call_output`).
- Used only when the outline can't express the target: a canvas, an unlabeled icon, or two failed resolutions.
- Input: a 1280×720 screenshot + goal. Output: a point action. Executed with `page.mouse`, saved as a `point` target, and the path is marked `portable=false`: it's replayed but never exported as a test.

### 20.6 Navigator rules
- It never sees `expected`, so it can't steer toward a pass.
- Login and identity are never handled by the model.
- Exploration is never the evidence. Evidence always comes from a clean, recorded replay.

## 21. Recorder

### 21.1 Isolation (identity per execution)

| Level | Requires | Behavior |
|---|---|---|
| `ephemeral_user` (best) | `session_hook` | Every execution (explore, record PR, record base, re-record, testgen validation) calls `POST {hook} {nonce}` and gets a **new user** with fresh server-side state |
| `reset_hook` | `reset_hook` + a user pool | Executions using the same user run **sequentially**, with a reset before each |
| `none` | nothing | Runs, but every verdict is capped at `inconclusive (no_isolation)` and the report explains how to add a hook |

**Isolation is decided per side.**
- The **PR side** sets the verdict cap.
- If only the **base side** lacks isolation (common right after install, when the merge base predates the hook), the PR verdict is unaffected. Before/after comparison and change detection are skipped, with a note.

**Hook contract (security):**
- Request headers `X-Intenzo-Timestamp: <unix seconds>` and `X-Intenzo-Signature: sha256=<hex HMAC-SHA256(hookSecret, timestamp + body)>`, where `timestamp + body` is the timestamp string followed by the raw body. The timestamp must be within 5 min of the server's clock.
- Answers: 200 (`{"shopper":"…"}` plus `Set-Cookie` for a session), 401 (bad signature, or a missing or stale timestamp), 503 (no secret configured). demo-shop's `lib/hooks.ts` is the reference implementation (T0.5).
- The hook **must** refuse when `VERCEL_ENV === "production"` (or the equivalent), with 403, before it even checks the signature.
- A reference implementation of about 15 lines ships in `docs/hooks.md` and demo-shop.

The base side uses the same hook on the merge-base preview.

### 21.2 Network handling
```ts
// Before any page loads: obtain the bypass cookie with a single direct request (no browser redirects)
const res = await context.request.get(laneOrigin + "/", {
  headers: { "x-vercel-protection-bypass": secrets.bypass, "x-vercel-set-bypass-cookie": "true" },
  maxRedirects: 0,
});   // Vercel answers with a host-only cookie, which lands in the context's cookie jar
// From here on, no secret headers are ever attached to browser requests.

const context = await browser.newContext({ serviceWorkers: "block", /* … */ });
await context.route("**/*", (route, req) => {
  const origin = new URL(req.url()).origin;
  if (req.isNavigationRequest() && req.frame() === page.mainFrame()
      && origin !== laneOrigin && !allowedNavOrigins.has(origin)) return route.abort();
  return route.continue();                                // no header injection at all
});
```
- The bypass is a **host-only cookie**, so it never reaches third-party origins or redirect targets.
- Service workers are blocked, so every request passes through routing.
- The PR and base lanes have different origins, so each gets its own cookie.

### 21.3 The observation protocol (identical for every criterion and both sides)
```
1. identity (§21.1); context: 1280×720, recordVideo 1280×720, tracing on, locale en-US, tz UTC
2. page = newPage(); goto(startPath); settle
3. SYNC MARKER: overlay a full-viewport #00FF00 div for 300 ms, then remove it  (§21.4)
4. box poller installed with context.addInitScript: on every document it re-queries the element watch
   targets and logs getBoundingClientRect each animation frame, stamped in EPOCH ms
   (performance.timeOrigin + performance.now()), into a page-side buffer flushed at each reading → boxTrack
5. setup steps (settle after each)
6. PRE readings:
     element watch → innerText + bbox
     region watch  → locator(region).ariaSnapshot()            (public API)
     LIVE REGIONS  → ariaSnapshot of every [role=alert|status|dialog|alertdialog], [aria-live], and
                     body-level children outside <main> (portals, toast containers)
7. trigger steps; Tt = the moment the last trigger action's promise resolves (NO settle before +0)
8. POST readings at Tt+0, Tt+1000, Tt+3000 (+ Tt+timingMs if set)
     element: innerText, or kind=absent if it doesn't resolve
     region and live regions: ariaSnapshot → line diff vs PRE → kind=region_diff
                              ("+ alert 'This code has expired'")
9. plain screenshot at Tt+1000 (annotation is drawn OFFLINE afterwards from the recorded bboxes,
   rendered by Chromium in a separate page, so nothing is ever drawn into the page or the video)
10. if criterion.persistence: reload → settle → after_reload readings
11. close → video; tracing.stop → trace.zip
```
- **Framework live regions count too.** Next.js keeps an empty body-level `role="alert" aria-live="assertive"` route announcer (`#__next-route-announcer__`) on every page, and it reads out the page title on client-side navigations. Its title announcements aren't app feedback, so the live-region readings leave it out (found in T0.6, done in T1.5).
- **Portals** are body-level children outside `<main>` that are fixed or absolutely positioned (where toast libraries mount). A live region inside a portal is read once, through the portal (T1.5).
- **Built in T1.6** (`core/browser/record.ts`):
  - the start page is the first setup step's `goto` (else `/`); every step waits up to 5 s for its target
  - lane status: a setup step failing → `setup_failed`; a trigger control that never shows up → `trigger_absent`; anything else, including the main frame leaving the app's origin → `error`
  - the **trigger window** for console errors and failed requests (§22.2) runs from the first trigger step to the last POST reading
  - the annotation is drawn by Chromium, like the T0.3 clips (no image library, no ffmpeg `drawtext`)

### 21.4 One canonical clock
- **Canonical time** = **epoch milliseconds** (`performance.timeOrigin + performance.now()`), used in both Node and the page. They share a host, so the two agree to under 1 ms, and page navigations don't reset it. Every step, reading and box sample is stamped with it. Reports show it relative to the lane start.
- **Video offset:** ffmpeg finds the marker frame: ≥ 90% of pixels with G > 200 and R, B < 80, which tolerates VP8/VP9 color shifts (Playwright 1.64 records VP9). `offset = markerVideoTime − markerCanonicalTime`.
  - If no marker is detected, the fallback is the trace's screencast frame timestamps, matched to the marker's canonical time.
  - If both fail → the lane is marked `infra_error` (never judged on a misaligned video).
- **Produced files:**
  - `humanVideo`: 1280×720 H.264, marker cut out, step captions burned in from the step log
  - `judgeVideo`: 960×540, 4 fps, **canonical timestamp burned in** using the offset, so the judge's `atMs` is already canonical. The time goes in a 40 px band *under* the frame (960×580), never over the page: in T0.3 a corner stamp covered the toast area. Don't rely on ffmpeg's `drawtext` for it: Homebrew's ffmpeg is built without freetype (T0.3 draws text with Chromium)
  - **How (T1.7, `core/browser/video.ts`):** both videos start on the first frame after the marker. The judge video samples canonical time on a 250 ms grid counted from the lane start, so stamps read `t=12.250s`, and each frame shows the last raw frame at or before its stamped time: what was on screen then, never something later. Captions (1.5 s each, stacked up to three) sit in the human video's bottom-left corner; values typed into secret-looking fields are masked. Text is drawn with Chromium and overlaid with ffmpeg. Takes go to `take-{n}` folders (§28).
  - each file stores its own offset in `videoOffsets`
- All report links and GIF windows convert canonical → file time at the very end.

## 22. Judge

### 22.1 Deterministic pre-judge
| Condition | Verdict / reason |
|---|---|
| `not_verifiable_in_ui` | inconclusive / not_verifiable_in_ui |
| PR lane `setup_failed`, `precondition_unmet`, `timeout`, `error` | inconclusive / setup_failed (or precondition_unmet / infra_error) |
| isolation `none` | judged, then capped at inconclusive / no_isolation |
| PR lane `trigger_absent` | **judged** with explore screenshots + region readings; `pass` impossible; `fail` allowed only if both judges agree and coverage ≠ `uncovered` |

### 22.2 Judge bundle (the same for both judges)
1. Criterion `text`, `expected`, `timingMs`, `persistence`, `sourceQuote`, and the PM video frame at `sourceMediaAt` if present
2. Design image(s)
3. **Annotated screenshot** (watch boxes labelled), with the question "are these the right elements?"
4. PR `judgeVideo` (canonical timestamps burned in) + the step log in canonical time, with `TRIGGER` marked
5. Readings table (`i`, label, kind, phase, t, value)
6. Base `judgeVideo` + readings, or "trigger absent on baseline at step k"
7. Counts of console errors and failed requests in the trigger window

Rules given in the prompt:
- Judge only this criterion.
- If the labelled boxes are not what the criterion is about → `targetCorrect=false`.
- `citedValue` must be copied verbatim from a reading when readings are relevant.
- Use the video for timing and visual claims.
- If unsure → `inconclusive`.

### 22.3 Combining the two judges (deterministic)
```
for each judge J: if J.targetCorrect == false → J' = inconclusive(wrong_target)
                  if J.verdict ∈ {pass, fail} and criterion.watch non-empty and kind ≠ ui_visual:
                      require J.citedReadings non-empty and valueMatches(J.citedValue, readings[J.cited])
                      else J' = inconclusive(contradicts_readings)
final = A'.verdict == B'.verdict ∈ {pass, fail}  → that verdict (reason agreed)
        otherwise                                → inconclusive (judges_disagree / wrong_target / contradicts_readings)
```
- **`valueMatches` works on tokens, not substrings.**
  - Tokenize both strings into numbers (currency/thousands stripped, parsed to 2-decimal values) and quoted or contiguous words.
  - If `citedValue` contains numbers, **every number must equal a whole numeric token** of a cited reading (`5.00` does not match `45.00`).
  - Otherwise the normalized cited string must **equal** a whole line of the reading, or a `region_diff` line (`+ alert "This code has expired"`).
  - An empty or null `citedValue` with non-empty `watch` → no match.
  - An `absent` reading has no value to cite. A live-region diff with nothing in it reads `no change`, which is citable: that's how a missing toast or error is cited (both judges did exactly this in T0.3).
- **Live-region readings count as citable.** A toast or portal error cited from the live-region diff satisfies the rule.
- Re-record behavior is defined in §19 step e: at most one re-record, and no judge-shopping.
- For `ui_visual` criteria, readings are optional: the judges decide from the video and annotated frames, with agreement still required.
- **Evidence window** = from the step log: `[Tt − 1000, Tt + 3000]` (`+ reload` if persistence). The judge's `atMs` is used only as a chapter hint in the report.

### 22.4 Aggregation
`any fail → fail; else any inconclusive → inconclusive; else pass`

### 22.5 Check conclusion
- `pass → success`, `fail → failure`, `inconclusive → policy.inconclusive_conclusion`.
- `superseded → neutral` (§16.3), `error → neutral` (Intenzo's own failures never block a merge), `cancelled → cancelled` (T2.2).
- **Note:** `neutral` satisfies required status checks. Teams that want "inconclusive blocks merge" should set `failure`. The comment explains which policy is active.

## 23. Evidence

| Criterion / target | Highlight source | Model |
|---|---|---|
| DOM element target | **rAF box track** (exact, every frame) → drawn box | none needed |
| `ui_visual`, canvas, image or chart content | **SAM 3.1** text-concept prompt (e.g. "the 10% slice of the savings chart") over the window, with the region's DOM box as an extra box prompt when available | SAM 3.1 |
| Vision-fallback (point) target | **SAM 3.1** point prompt at the clicked coordinates | SAM 3.1 |

```
window = evidenceWindow (canonical) → humanVideo time
frames = 10 fps over the window, padded to ≥ 50 frames (SAM minimum)
render = outline (2 px #FF3B30) + caption "C2 ❌ total stayed $50.00 after Apply"
gif    = ffmpeg palettegen/paletteuse, 640 px, 8 fps, ≤ 2 MB (lower fps, then width, until it fits)
still  = PNG of the frame at Tt+1000 with the highlight
SAM timeout 20 s → fall back to the annotated screenshot
```
For SAM to do real work on camera, the demo ticket includes **a canvas chart criterion** (§32).

## 24. Unrequested-change detection (aria diff)
```
skip entirely if: no baseline, base side not isolated, or baseline drift > 0 (§17.3)
routes = the trigger route of each criterion ∪ coverage.routes (hackathon: max 2; v1: max 5),
         excluding URLs with ephemeral ids
for each route, with a fresh identity per side:
   snapPR, snapBase = normalized AX outline text (roles + names + text), with lane-specific strings masked
                     (the ephemeral user's name/email, dates, times, currency amounts tied to cart state)
   hunks = sequence diff (Myers) over lines → insertions / deletions / modifications, grouped by landmark
   drop hunks inside regions touched by any criterion's trigger or watch region (those are expected)
Spark 1.3 (changes.v1): criteria + hunks (+ element crops from both sides for each hunk)
   → [{hunkId, explainedBy: "C2" | null, description, confidence}]
report: explainedBy == null && confidence ≥ 0.7 (max 3), e.g. 'checkout button "Pay now" → "Continue"'
```
The sequence diff handles inserted content without shifting everything after it, unlike a pixel diff. Cut order: last-but-one (§33).

## 25. Test generation (Muse Code). **Stretch for the hackathon.**
- For each `pass` criterion with a portable path, **Muse Code** (testgen.v1) gets the saved path, the PASSING readings and `expected`. It returns a Playwright spec using the same durable targets, with assertions built from the passing readings:
  `await expect(page.getByTestId("order-total")).toHaveText("$45.00", { timeout: 1000 })`
- **Validation:** run it **once** with `@playwright/test` against the PR preview, under a fresh identity through a generated fixture that calls the session hook. Keep it only if it passes.
- Delivered as a collapsed suggestion block in the comment. No contents write in v0.

## 26. Reporting

### 26.1 Comment lifecycle (one comment per run group, rebuilt from the DB on every change)
1. **Placeholder:** "Intenzo is waiting for the preview…"
2. **Criteria posted** (intent ready): the list + coverage warnings ("C3 isn't touched by this PR")
3. **Verdicts stream in:** each `criterion_verdict` updates its row
4. **Evidence streams in:** GIFs appear as `criterion_evidence` arrives
5. **Final:** outcome, unrequested changes, tests, cost, timing, attempt history

```
### Intenzo · verified against #42 "Discount codes"           ❌ 3/4 passed · attempt 1
| | Criterion | Evidence |
|---|---|---|
| ✅ | C1 SAVE10 applies a 10% discount | ▶ [0:04–0:08](…/r/{run}#C1) |
| ❌ | C2 Total updates instantly (no refresh) | ![C2](gif) |
| | Expected $50.00 → $45.00 within 1 s. Readings: +0 s $50.00 · +1 s $50.00 · +3 s $50.00 · after reload $45.00 | |
| ✅ | C3 Expired code shows "This code has expired" | ▶ […] |
| ✅ | C4 Savings chart shows the 10% slice | ▶ […] |
⚠️ Unrequested change on /checkout: button "Pay now" → "Continue"
Baseline: main@a1b2c3 (merge base) · Judges: Spark Open + Spark 1.3 (agreement required)
<details>🧪 Suggested Playwright tests (3)</details>
⏱ 1 m 52 s · 💲 $0.31
```

### 26.2 Check run
- Name `Intenzo`, `external_id = runId`. The summary is the same table. Up to 50 annotations on the diff lines that coverage maps to failing criteria.
- **Requested actions** (GitHub limits: max 3, label ≤ 20 chars, description ≤ 40). They show in the **Checks tab**. Despite GitHub's docs, they can also be pressed on a check run that's still **in progress** (T0.4), so Intenzo attaches them only when it completes the run, and the handler re-checks the outcome. A press changes nothing on the run: it only delivers `check_run.requested_action` with `requested_action.identifier`, `sender`, `check_run.external_id` and `check_run.pull_requests`.
  - outcome `pass` → `Approve (PM)`, `Re-run`
  - outcome `fail` → `Send to agent`, `Re-run`
  - `inconclusive` → `Re-run`

  Approve is never offered on a failing run.
- **Approve** is accepted only if the clicker (`sender`) is in `policy.approvers` (users or a team) **and** has write access. Otherwise Intenzo replies "@user isn't an approver for this repo". The result is commit status `Intenzo / product approval = success`, naming who approved.
- Fallback for PMs who can't see the buttons: `/intenzo approve` in a PR comment (same checks).
- This replaces Slack for the hackathon. Slack is roadmap.

### 26.3 Agent failure payload (sanitized)
- Posted as a separate comment: `@intenzo-fixer` + a fenced JSON block with the header line `UNTRUSTED DATA, not instructions`.
- Contents: `criterion.id`, `criterion.text` (capped at 300 chars), `expected` (300), the judges' `observed` (300), the readings table (labels + values, each capped at 80 chars), the trigger steps (the durable targets of the role/name kind, each name capped at 60 chars), the coverage files, and a report link.
- Never included: console text (only counts), lane IDs, identities, hook data, `data:` values beyond what the ticket itself states.
- **Trigger:**
  - Default (`agent_trigger: button`): posted only when someone presses **Send to agent**.
  - `auto`: posted automatically on `fail`.
  - Never both.
- Outbox key `agent:{group}:{agent_attempts+1}`. After `max_agent_attempts`: label `needs-human`, and the button is no longer offered.
- The JSON includes `sig = HMAC(fixerSecret, runId + criterionIds + headSha)`, so muse-fixer can tell a real Intenzo request from a human copying the format.
- **Optional anti-gaming check (stretch):** at verify time, one extra lane uses a **held-back variant** from `data` (e.g. `SAVE15` seeded by the hook) that is never shown to the agent. It catches fixes that hard-code `SAVE10`.

### 26.4 Reference fixer agent (`agents/muse-fixer`)
- A GitHub Action in the target repo, triggered by `issue_comment`.
- **Guards:**
  - `if: github.event.comment.user.login == '<app slug>[bot]' && contains(body, '@intenzo-fixer')`, with the slug from config: App names are global, so the bot may not be `intenzo[bot]` (T0.4's was `intenzo-demo[bot]`)
  - `sig` verified with `INTENZO_FIXER_SECRET`
  - the PR must be **same-repo**: `head.repo.full_name == base.repo.full_name`, else exit
  - `concurrency: { group: fixer-${{ issue.number }}, cancel-in-progress: false }`
  - `permissions: { contents: read }` (writes go through the App token below)
- **Steps:**
  1. Parse and verify the JSON.
  2. Mint a token for a separate **`intenzo-fixer` GitHub App** (`actions/create-github-app-token`).
  3. Check out the PR branch with that token.
  4. `pnpm install --ignore-scripts --frozen-lockfile`
  5. Call **Muse Code** with the failure, `related_files` and the repo (plus "also propose a Playwright test", if testgen lives here, §4).
  6. Apply the patch.
  7. `pnpm typecheck`
  8. Commit and push **with the App token**. Unlike `GITHUB_TOKEN` pushes, this starts the repo's CI.
- **Known exposure:** the fixer runs PR-branch code (typecheck) in a job holding the Muse Code key. That's acceptable only for same-repo PRs from trusted authors, which is why forks are refused.
- **Verified (T0.4, B-7):** a comment made with the App's installation token does start the `issue_comment` workflow, and the guard above matches it. A human comment in the same format starts it too, and the guard skips it.
- The push triggers Vercel → `deployment_status` → a new Intenzo run.
- Any other coding agent (Claude Code, Copilot) can consume the same payload.

---

# Part IV: Cross-cutting

## 27. Timing (honest)

| Scenario | Target | Where the time goes |
|---|---|---|
| Criteria posted | 20–40 s after the preview is ready (intent is reused on later runs) | Transcribe + Spark video, first run only |
| **Warm, cached path, all pass**, 4 criteria | **verdicts ≈ 90–120 s** after the preview is ready | 2 recording slots: 4 criteria × (PR + base ≈ 25 s) / 2 ≈ 50 s; the judge queue overlaps recording, and the last judge finishes about 10 s after the last recording (T0.3, `low` effort: slowest of both judges p50 6.4 s, max 9.4 s); coverage overlaps |
| **First run with a failure** | verdicts ≈ 3–5 min; evidence streams 30–60 s later | exploration (5–25 Wonder calls per criterion) + intent + re-recording the failing lane + SAM |
| Fix loop (button → agent → Vercel rebuild → new run) | ≈ 3–4 min | the agent ≈ 60–90 s, the Vercel build ≈ 60 s, the new run reuses intent and paths |

All numbers get re-measured on Friday with the walking skeleton, and this table is updated.

Demo: Modal pre-warmed (Baseten Model APIs showed no cold start). Demo paths are explored once beforehand, and the video says so. The fix loop is shown with an honest on-screen time-lapse marker.

## 28. Artifact storage and privacy
- **Paths:** `runs/{runId}/{criterion}/{side}/take-{n}/{file}`. Every recording is a new take, so re-records never overwrite the take a verdict cites. Verdicts reference takes explicitly.
- **Upload:** the worker requests tokens **when it needs them** (per file, or a small batch) from `/api/worker/upload-tokens`. Cloud issues a client token for that exact pathname if it's under `runs/{runId}/` for the job's run. Uploads go straight to Blob, so large videos never pass through Vercel functions.
- **Two stores** means two read-write tokens. They're connected with distinct env var prefixes (`PUBLIC_BLOB_…`, `PRIVATE_BLOB_…`) and chosen explicitly in code.
- **Stores:**
  - `intenzo-public`: GIFs and stills for public repos (inline through GitHub's image proxy)
  - `intenzo-private`: videos, traces and bundles, served via the report page. For **private repos (roadmap)**, inline GIFs are served from a Cloud route `/g/{random}.gif` that checks expiry and revocation and streams from the private store. The full report needs GitHub OAuth plus a repo-access check.
- **Retention:** videos 30 days, bundles 7 days, verdicts and ledger kept. Repo code is never stored beyond the diff in a bundle.

## 29. Security

| Threat | Mitigation |
|---|---|
| Forged webhooks or worker events | HMAC on webhooks; job-scoped JWTs (20 min); 410 for stale jobs |
| Worker credential exposure | No GitHub token in the worker; per-file Blob tokens; secrets decrypted only into VerifyJob payloads |
| **Secrets reaching PR code** | Anything sent to a preview (hook signatures, test passwords, bypass header) is **visible to that PR's code**. So: no secrets at all for fork PRs (`allow_forks=false` by default; with forks allowed, only no-secret isolation applies). Test users are disposable, with no real data. The documentation tells customers that the bypass token is project-wide and suggests a dedicated protection-bypass secret for Intenzo, rotated regularly |
| Bypass header leak | Added only to requests for the lane origin (§21.2) |
| Test hooks as backdoors | HMAC-signed, with a timestamp; refuse in production; the reference implementation enforces both |
| Production contact | **The authoritative guard is the deployment environment filter:** only deployments whose GitHub environment is non-production **by name** are ever used, for both sides (Vercel's `production_environment` flag is `false` even on Production, T0.4). `prod_domains` is a second line of defence (production deployments also have unique `*.vercel.app` URLs that it can't list). Hooks refuse production themselves |
| Destructive actions | `deny_text` + defaults (delete, remove, cancel subscription, pay, purchase, place order, transfer); the navigator only acts on ids from the outline |
| Off-site navigation | Main-frame navigations limited to the lane origin + `extra_navigation_origins` |
| **Prompt injection** (ticket, PR body, page, console) | Untrusted blocks; the navigator never sees `expected`; two independent judges must agree; `citedValue` is checked against readings; `sourceQuote` is shown in the report so people can spot injected criteria; the agent payload is sanitized (§26.3) |
| Intent tampering by the PR author | Criteria come from the linked ticket. The PR body is used only when there's no ticket, labelled "unverified" |
| Quota abuse | Commands need write access; at most 3 concurrent verify jobs per installation; a daily run cap |

## 30. Observability
- Every run has a `run_events`-style timeline, built from the outbox + `model_calls` + job events and shown on the report page (debug mode).
- `model_calls`: latency, tokens, video seconds, cost, prompt version. These feed the bench charts and cost per PR.
- Worker JSON logs (`runId`, `jobId`, `criterionId`, `lane`); Playwright traces for every lane.
- Every webhook delivery Intenzo acts on is stored in `webhook_events` with its raw payload, and whether its dispatch succeeded (T2.1).

## 31. Testing and IntentBench

### Testing
| Level | What |
|---|---|
| Unit (Vitest) | schemas, config, `transition()`, outbox keys, route mapping, `durableTarget`, `settle`, judge combination + normalization, aria diff, comment renderer; webhook intake and the database layer, against an in-process Postgres (PGlite) with the real migrations |
| Model contract | recorded fixtures per prompt version; a nightly live run |
| Browser | recorder + marker alignment + readings + isolation against local demo-shop |
| Pipeline | `intenzo run --local --pr http://localhost:3001 --base http://localhost:3000 --ticket cases/discount` |
| System | a real PR on demo-shop through the hosted path |

### IntentBench (record once, judge many)
- **12 cases** on demo-shop: 4 correct, 5 almost-right, 2 with unrequested side effects, 1 broken. Each case has about 3–4 criteria (~40 criteria in total) with human ground-truth labels.
  - **Correct implementations** are written by Muse Code from the ticket.
  - **Almost-right defects are hand-seeded** into those branches and labelled "seeded". A good model writes correct code, so models don't reliably produce almost-right cases on their own.
- **Stratified split:**
  - tuning: 1 correct + 2 almost-right + 1 side-effect (4 cases)
  - held out: 3 correct + 3 almost-right + 1 side-effect + 1 broken (8 cases)

  Only held-out numbers are reported, with the small-n caveat.
- **Phase 1, record:** for each case, explore + record **2 takes** of each PR lane and 1 base take → a frozen evidence pack (videos, readings, screenshots). With 2 takes, the bench applies the real §19 step e rule. Cases where exploration fails are reported as a `setup_failed` row, never dropped.
- **Phase 2, judge (offline, cheap, repeated 3×):**

| Arm | Judge input |
|---|---|
| A. Diff-only review | ticket + diff → Spark 1.3 (no browser) |
| B. Readings only | readings table + step log, no images |
| C. Frames | 2 fps stills + readings |
| D. Video | judgeVideo + readings (Spark Open + Spark 1.3 agreement; each model also reported alone) |

- **Metrics:**
  - per-criterion accuracy
  - **catch rate on almost-right**
  - **false-failure rate on correct**
  - inconclusive rate
  - side-effect detection
  - time to verdict and cost per PR
- Reported with the mean ± spread over 3 judge repeats, plus the small-n caveat. Python (`analysis/*.py`) reads the results JSON directly.

## 32. Demo storyboard (3 minutes)

**Demo ticket** ([demo-shop #5](https://github.com/sumithprabhu/demo-shop/issues/5); "#42" was illustrative. Filed as a **PM screen recording with narration**, 36.5 s, made reproducibly by `pnpm demo:pm-video`, with the timeline in `demo/README.md`):
> "On the cart, when I apply SAVE10 the total should drop 10% right away, no refresh. OLD5 is expired, so show 'This code has expired'. And the savings chart in the summary should show the discount slice."

This becomes 4 **decoupled** criteria:
- **C1:** a "SAVE10 −$5.00" discount line appears (watch: the discount line)
- **C2:** the order total updates to $45.00 within 1 s, without a refresh (watch: order total; persistence)
- **C3:** the expired code shows "This code has expired" (rendered as a **toast**, which exercises the live-region reading)
- **C4:** the canvas savings chart shows the discount slice (ui_visual → SAM 3.1; driven by the line items, like C1)

**The almost-right PR** (the implementation written by Muse Code, the defect hand-seeded):
- The discount line item and the chart update immediately from the line items, so C1 ✅ and C4 ✅.
- The **order total** is computed from a stale cart snapshot and only corrects on reload, so C2 ❌. Concretely (`pr/discount-almost-right`), the total is a `useMemo` missing the discount code as a dependency. It survives Next.js's re-render after the background save, and quantity changes still update it, so the PR's CI stays green (T0.6).
- The **cart page's** "Checkout" button is relabelled "Continue". It's on the trigger route, so §24 sees it → ⚠️ unrequested.

**Golden file first:** `demo/expected-comment.md` (the comment exactly as it should look) is written on Thursday. From Saturday on, every pipeline change is checked against it.

| Time | Beat | Models visible |
|---|---|---|
| 0:00–0:15 | Hook: "Teams using AI merge +98% more PRs, but review time is up 91%" (source on screen: Faros AI 2026). "Nobody can answer: did it do what we asked?" | — |
| 0:15–0:40 | The PM records the ticket video; Intenzo posts 4 criteria with quotes and timestamps from the video | Voice Transcribe, Spark 1.3 video |
| 0:40–1:20 | The agent's PR → the comment fills in live: C1 ✅, C2 ❌ with readings + GIF, C3 ✅ (toast), C4 ✅ with the SAM-highlighted chart, ⚠️ "Checkout" → "Continue" | Wonder, Spark Open + Spark 1.3, SAM 3.1 |
| 1:20–1:50 | Checks tab → "Send to agent" → muse-fixer pushes a fix (time-lapse) → the new run is all green | Muse Code |
| 1:50–2:05 | The PM (listed in `approvers`) clicks "Approve (PM)" in the Checks tab → the product approval status turns green → merge | — |
| 2:05–2:40 | IntentBench held-out chart: diff-only vs readings vs frames vs video; false-failure rate; cost per PR; "Spark Open = open weights, self-hostable" | — |
| 2:40–3:00 | Close and an honest list of what was built during the hackathon | — |

Backup: a recorded take of the full run, in case anything is down during judging.

## 33. Build plan (Thu Oct 29 → Wed Nov 4)

| Day | Build | Exit check |
|---|---|---|
| **Thu Oct 29** | Credits. **Day-1 unknowns, before any pipeline code:** 10 hand-recorded clips → Spark 1.3 + Spark Open (video vs frames, latency, accuracy, **and the inconclusive rate under the agreement rule**); whether Muse Code has an API; Voice Transcribe streaming; the bot-comment → workflow trigger. demo-shop (discount feature with decoupled line item / total / chart, toast errors, HMAC hooks, `release` as production branch). `demo/expected-comment.md` | Every fallback in §4 and R1–R5 decided; demo-shop previews for `main` + PR |
| **Fri Oct 30** | **Walking skeleton, local first:** recorder + epoch clock + readings + live regions against local demo-shop with **one hand-written SavedPath** (morning). Then the hosted path: GitHub App + webhook → `deployments` → run → Modal spawn → that worker → comment + check run via the outbox with SKIP LOCKED (afternoon/evening) | A real demo-shop PR gets a comment with a real video, end to end |
| **Sat Oct 31** | `_snapshotForAI` outline + navigator explore + durable targets (morning); intent (text + PM video) + dual judge + `valueMatches` + re-record rule + streaming comment (afternoon) | The CLI matches `expected-comment.md` on the demo PR |
| **Sun Nov 1** | Evidence (box track + SAM for the canvas chart); muse-fixer (guards, App token) + the "Send to agent" loop; requested actions with the approver check; one-route change detection | Closed loop: fail → fix → pass on a real PR |
| **Mon Nov 2** | IntentBench: 12 cases (4 written by Muse Code + hand-seeded defects), record 2 takes, judge 4 arms × 3; charts | Held-out charts with real numbers |
| **Tue Nov 3** | Hardening, pre-warming, README (architecture, honest limits), landing page, demo takes ×3 + a backup take | Full demo three times in a row without manual fixes |
| **Wed Nov 4** | Edit the video, submit by 6 PM ET, X post | Submitted |

**Stretch from the start** (only if a day finishes early): testgen (§25), the anti-gaming variant, vision fallback.

**Cut order if still behind:**
1. Change detection
2. PM approval via requested actions (keep `/intenzo approve`)
3. Bench down to 8 cases

**Never cut:**
- the walking skeleton
- the clean recorded replay with readings
- dual-judge video judging
- the PM video ticket
- the SAM canvas criterion
- the fix loop
- held-out IntentBench

## 34. Risks and open questions

| # | Risk | Plan |
|---|---|---|
| R1 | Meta API video input format and limits | **Resolved (T0.2):** inline MP4 `video_url` works on Spark 1.3 (5 s clip ≈ 1.3k prompt tokens, 2.9 s p50); Files API upload works too. Size limit still unpublished |
| R2 | Baseten Spark Open may not accept video | **Resolved (T0.2b):** it does. Native `video_url` MP4 read correctly in 2.8 s (946 prompt tokens) vs frames mode 5.3 s (3,460). Both judges take the same inline video |
| R3 | Judge latency | **Measured (T0.3):** with `reasoning_effort: low`, both judges in parallel took p50 6.4 s, max 9.4 s per criterion (default effort: p50 10.1 s, max 33.1 s, all Spark 1.3 reasoning). 4 fps, short windows, verdicts streamed |
| R4 | Wonder computer-use API | **Resolved (T0.2):** Wonder rejects the tool; Spark 1.3 runs the loop correctly and is the fallback |
| R5 | **Muse Code has no programmatic API** | **Resolved (T0.2):** confirmed CLI-only. `muse exec --json` completed a task headless on macOS in 24 s; Linux/Actions (bubblewrap) is checked in T5.3. Decision tree in §4: CLI only → Muse Code lives in muse-fixer (fix + proposed test), and coverage moves to Spark 1.3. If even the CLI can't run headless in Actions, the fixer uses Wonder and says so plainly. The worker never gets a repo checkout |
| R13 | **Mostly-inconclusive output** (agreement rule + citation rule) | **Measured (T0.3): 0 of 8 clear clips inconclusive** at both efforts, every citation matched, so the strict rule stays. Re-check on IntentBench (P6). The fallback, if it's ever above about 30% on clear cases: "agreement for fail; for pass, the primary judge plus a clean readings check" |
| R14 | Internal `_snapshotForAI` API changes | Exact version pin + contract test; `data-iz-ref` tagging fallback (§20.1) |
| R6 | Exploration on deep flows | `repro.startPath` from the PM video, route candidates, `trigger_absent` handling, a path cache within the run group |
| R7 | Customer test isolation | Isolation levels; `no_isolation` cap; hook reference implementation |
| R8 | Merge-base preview missing for customers | Drift walk and the `baseUrl=null` fallback are built (T2.3). v1: trigger a Vercel preview through the API |
| R9 | Private-repo media and GIFs | `body_html` signed URLs; `/g/` proxy (roadmap) |
| R10 | Voice Transcribe is realtime-only | **Resolved (T0.2):** a file endpoint exists and is accurate; neither mode returns timings |
| R11 | Vercel environment naming in `deployment_status` | **Resolved (T0.4):** exactly `Preview` / `Production`; `environment_url` = `target_url`; `ref` = SHA; `production_environment` always `false`. The catch: Vercel's per-project "deployment_status Events" toggle was off on a new project, so onboarding must turn it on (§17.1) |
| R12 | Judges agree on the wrong answer (correlated errors) | Readings checks + annotated-target check; bench reports false-pass rate per arm. T0.3: the judges also agree on how to read a *vague* criterion (both passed both ambiguous clips), so the intent step must make criteria concrete (T4.1) |
