// The verify job (§19): the ticket's criteria (the job's intent, else the demo's fixtures) are
// each recorded on the PR preview and, when the run has one, the base preview. With the navigator
// (a recorder that can explore, T3.5), each PR side replays the run group's cached path or
// explores for one (§19 3a–b), and new paths go back to the Cloud as path_saved; without it, the
// hand-written paths (fixtures/paths) are used. The people's videos are uploaded (§28).
// With both judges' keys (T4.6b), each criterion is judged (§22) in a queue apart from the
// recording slots, re-recorded once when §19 e says so; without them, it gets the stub's verdict.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type ArtifactRef,
  ContextBundle,
  type CoverageMap,
  type Criterion,
  type CriterionSet,
  type IntenzoConfig,
  type LaneResult,
  type ReasonCode,
  type RunOutcome,
  SavedPath,
  takePath,
  type Target,
  type UnrequestedChange,
  type Verdict,
  type VerifyJob,
} from "@intenzo/core";
import {
  changeRoutes,
  changeTargets,
  classifyChanges,
  diffSnapshots,
  dropExpected,
  reportable,
  skipChanges,
} from "@intenzo/core/changes";
import {
  afterRerecord,
  type Judge,
  type Judged,
  judgeCriterion,
  type JudgeSide,
  rerecordFor,
  verdictOf,
} from "@intenzo/core/judge";
import { COVERAGE_MODEL, mapCoverage } from "@intenzo/core/coverage";
import {
  countsTowardOutcome,
  extractIntent,
  intentSources,
  mergeIntents,
  type IntentPart,
  type IntentSourceText,
  INTENT_MODEL,
  prepareTicketVideo,
  type TicketVideo,
} from "@intenzo/core/intent";
import {
  costUsd,
  metaModelPort,
  type ModelPort,
  type ModelUsage,
  transcribeCostUsd,
} from "@intenzo/core/models";
import {
  NAVIGATOR_MODEL,
  PathCache,
  recordWithPath,
  type ExploreResult,
} from "@intenzo/core/navigator";
import {
  type BoxSample,
  captionOf,
  type EvidenceInput,
  type EvidenceOutput,
  outlinedLabel,
  type RouteSnapshot,
  samSegmenter,
} from "@intenzo/core/browser";

import { type JobClient, StaleJobError } from "./client.ts";
import { Limiter } from "./limiter.ts";
import { type PreflightResult, PreviewUnreachable } from "./preflight.ts";
import { stubIntent, stubOutcome, stubVerdict } from "./stub.ts";
import { uploadArtifacts } from "./upload.ts";

export interface LaneInput {
  side: "pr" | "base";
  origin: string;
  criterion: Criterion;
  path: SavedPath;
  /** The session hook (§21.1); without it the lane has no isolation. */
  identity?: { hookPath: string; secret: string };
  /** Vercel's protection bypass (§21.2). */
  bypass?: string;
}

export interface RecordedLane {
  /** humanVideo and videoOffsets are filled in here, once the video is uploaded. */
  lane: LaneResult;
  /** Where each watched element was on every animation frame (§21.3), for the evidence GIF. */
  boxTrack?: BoxSample[];
  /** human.mp4 on disk and both videos' offsets (§21.4), when the video could be made. */
  video: { humanFile: string; offsets: { human: number; judge: number } } | null;
  /** judge.mp4 and the annotated Tt+1000 still on disk, for the judges (§22.2). */
  judge?: { video: string; annotatedShot?: string };
}

export interface ExploreInput {
  origin: string;
  criterion: Criterion;
  config: IntenzoConfig;
  identity?: { hookPath: string; secret: string };
  bypass?: string;
}

export interface Recorder {
  record(input: LaneInput): Promise<RecordedLane>;
  /** Renders a criterion's evidence GIF and still (§23); the recorder's own Chromium draws them. */
  evidence?(input: Omit<EvidenceInput, "outDir">): Promise<EvidenceOutput>;
  /** Explores the PR app for a criterion's trigger (§20.3), when the worker has the navigator. */
  explore?(input: ExploreInput): Promise<ExploreResult>;
  /** A route's masked aria snapshot, with a fresh identity, for the aria diff (§24). */
  snapshot?(input: SnapshotInput): Promise<RouteSnapshot>;
  /** §19 step 1: whether a preview answers at all, before anything is recorded on it. */
  preflight?(input: { origin: string; bypass?: string }): Promise<PreflightResult>;
  close(): Promise<void>;
}

export interface SnapshotInput {
  origin: string;
  route: string;
  /** What the criteria touch there: their trigger targets and watched elements. */
  targets: readonly Target[];
  identity?: { hookPath: string; secret: string };
  bypass?: string;
}

const NO_TOKENS = { promptTokens: 0, cachedTokens: 0, completionTokens: 0, reasoningTokens: 0 };
/** §19: two recordings at a time (CPU), and two criteria judged at a time (four judge calls). */
export const RECORDING_SLOTS = 2;
export const JUDGE_SLOTS = 2;
const PATHS_DIR = new URL("../../../../fixtures/paths/", import.meta.url);
/** Takes tried per file before giving up: earlier jobs of the same run may have left some (§28). */
const MAX_TAKES = 5;

/** The criterion's path: a saved one from the run group, else the hand-written fixture. */
export function pathFor(criterionId: string, cached: readonly SavedPath[]): SavedPath | null {
  const saved = cached.find((p) => p.criterionId === criterionId);
  if (saved) return saved;
  try {
    const file = new URL(`${criterionId}.json`, PATHS_DIR);
    return SavedPath.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Replaces every secret of the job in a text, before it's logged or sent anywhere. */
export function redactor(secrets: VerifyJob["secrets"]): (text: string) => string {
  const values = [
    secrets?.hookSecret,
    secrets?.bypass,
    ...(secrets?.users ?? []).map((u) => u.password),
  ].filter((v): v is string => typeof v === "string" && v.length > 0);
  return (text) => values.reduce((out, value) => out.replaceAll(value, "[redacted]"), text);
}

/** §22.1's reason when the PR side didn't complete; there are no judges yet to look further. */
const REASONS: Record<Exclude<LaneResult["status"], "completed">, ReasonCode> = {
  setup_failed: "setup_failed",
  precondition_unmet: "precondition_unmet",
  // The control the trigger needs isn't there. The judges will look at it (P4); the stub can't.
  trigger_absent: "precondition_unmet",
  timeout: "infra_error",
  error: "infra_error",
};

/** The stub's fixed verdict on a real recording: it stands only when the PR side completed. */
export function recordedVerdict(
  criterionId: string,
  pr: LaneResult | null,
  notFound?: Exclude<ExploreResult, { status: "found" }>,
): Verdict {
  const fixed = stubVerdict(criterionId);
  if (pr?.status === "completed" && pr.tTriggerMs !== null) {
    const tt = pr.tTriggerMs;
    return { ...fixed, evidenceWindow: { startMs: tt - 1000, endMs: tt + 3000 } };
  }
  const observed = pr
    ? `Not judged: the PR recording ended "${pr.status}".`
    : notFound
      ? `Not judged: the navigator couldn't reach the trigger (${notFound.status}: ${notFound.reason}).`
      : "Not judged: the PR side wasn't recorded.";
  const reasonCode =
    pr && pr.status !== "completed"
      ? REASONS[pr.status]
      : notFound
        ? REASONS[notFound.status]
        : "infra_error";
  const judge = { ...fixed.judges[0]!, verdict: "inconclusive" as const, observed };
  return {
    ...fixed,
    verdict: "inconclusive",
    reasonCode,
    evidenceWindow: null,
    observed,
    judges: [judge, judge],
  };
}

/** A file of a take: videos to the private store, GIFs and stills to the public one (§28). */
export interface StoredFile {
  name: string;
  contentType: string;
  body: Uint8Array<ArrayBuffer>;
  store?: "public" | "private";
  /** The take the file belongs to: the evidence goes beside the video it's cut from (§28). */
  take?: number;
}

/** Uploads one file of a take into the first take number no earlier job of the run has used. */
async function uploadTake(
  client: JobClient,
  lane: LaneResult,
  runId: string,
  file: StoredFile,
): Promise<ArtifactRef> {
  const takes = file.take ? [file.take] : Array.from({ length: MAX_TAKES }, (_, i) => i + 1);
  for (const take of takes) {
    const path = takePath(runId, lane.criterionId, lane.side, take, file.name);
    try {
      const [ref] = await uploadArtifacts(client, [
        { store: file.store ?? "private", path, contentType: file.contentType, body: file.body },
      ]);
      return ref!;
    } catch (err) {
      if (!/already exists/i.test(String(err))) throw err;
    }
  }
  throw new Error(`no free take for ${lane.criterionId} ${lane.side} in ${MAX_TAKES} tries`);
}

/** Waits before the intent call's next try; the last three only for a transient failure. */
export const INTENT_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 90_000];
/** Failures worth waiting out: Meta's outages, not a reply that didn't fit. */
const TRANSIENT = /HTTP (404: .*model_not_found|429|5\d\d)|request failed/;

export interface VerifyDeps {
  recorder: Recorder;
  /** The Meta key: the job reads its ticket (intent) and maps coverage with it (§18). */
  metaKey?: string;
  /** The model port for intent and coverage; by default the Meta API with metaKey. */
  models?: ModelPort;
  /** Reads the PM's recording from its signed URL (transcript and video); injectable for tests. */
  readRecording?: (url: string) => Promise<TicketVideo>;
  /**
   * The pauses before a failed intent call is tried again (tests make them short): all of them for
   * a failure that looks transient, the first only for any other.
   */
  retryDelaysMs?: readonly number[];
  /** Spark Open and Spark 1.3 (judgesFromEnv); null: stub verdicts. */
  judges?: readonly [Judge, Judge] | null;
  log: (line: string) => void;
  /** Where a take's human video goes; by default the run's private Blob store (§28). */
  store?: (lane: LaneResult, file: StoredFile) => Promise<ArtifactRef>;
}

export interface VerifyResult {
  outcome: RunOutcome;
  /** List-price spend on model calls: the navigator's and the judges'. */
  costUsd: number;
}

/** A recorded side: its lane as reported (redacted, video cited) and its files for the judges. */
interface Side {
  lane: LaneResult;
  judge: JudgeSide;
  /** The human video and box track the evidence GIF is cut from (§23). */
  evidence?: { humanFile: string; humanOffsetMs: number; boxTrack: BoxSample[] };
}

/** A verdict decided without the judges, in their place in the report (§22.1). */
function notJudged(criterionId: string, reasonCode: ReasonCode, observed: string): Verdict {
  return {
    criterionId,
    verdict: "inconclusive",
    reasonCode,
    evidenceWindow: null,
    observed,
    judges: [],
  };
}

export async function verify(
  job: VerifyJob,
  client: JobClient,
  deps: VerifyDeps,
): Promise<VerifyResult> {
  const { recorder, log } = deps;
  const judges = deps.judges ?? null;
  const redact = redactor(job.secrets);
  const slots = new Limiter(RECORDING_SLOTS);
  const queue = new Limiter(JUDGE_SLOTS);
  let spent = 0;
  const spend = (model: string, usage: ModelUsage) => (spent += costUsd(model, usage) ?? 0);

  /**
   * One source's criteria (§18): a ticket's text, and its PM recording when it has one (T4.2), or
   * the PR's own criteria as a checklist.
   */
  const readSource = async (source: IntentSourceText, models: ModelPort): Promise<CriterionSet> => {
    const { ticket } = source;
    let recording: TicketVideo | undefined;
    const read = deps.readRecording ?? (deps.metaKey ? readRecordingFrom(deps.metaKey) : null);
    if (source.videoUrl && read) {
      try {
        recording = await read(source.videoUrl);
        spent += transcribeCostUsd(recording.transcript.audioDurationMs ?? 0);
      } catch (err) {
        log(
          redact(`${ticket.ref}'s recording couldn't be read: ${(err as Error).message}`).slice(
            0,
            300,
          ),
        );
      }
    }
    const readTicket = () =>
      extractIntent(models, ticket, {
        intentSource: recording ? "linked_issue_video" : source.intentSource,
        ...(recording && {
          transcript: recording.transcript.text,
          video: {
            dataUrl: recording.dataUrl,
            ...(recording.transcript.audioDurationMs && {
              durationMs: recording.transcript.audioDurationMs,
            }),
          },
          mediaHashes: [recording.mediaHash],
        }),
      });
    // A failed call is tried again: a reply that didn't fit once more, and an outage of Meta's
    // (429, 5xx, its 404 model_not_found for a served model, #115) for up to about three minutes.
    // Failed calls cost nothing. Running out fails the job, so no empty intent is ever reported.
    let result = await readTicket();
    spend(INTENT_MODEL, result.usage);
    const delays = deps.retryDelaysMs ?? INTENT_RETRY_DELAYS_MS;
    for (let n = 0; !result.ok && result.intent.criteria.length === 0; n++) {
      const problems = result.problems.join("; ");
      const transient = TRANSIENT.test(problems);
      if (n >= (transient ? delays.length : 1)) {
        throw new Error(`${sourceName(ticket.ref)} couldn't be read: ${problems}`.slice(0, 400));
      }
      log(
        redact(`intent: ${problems}: trying again in ${Math.round(delays[n]! / 1000)} s`).slice(
          0,
          300,
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, delays[n]));
      result = await readTicket();
      spend(INTENT_MODEL, result.usage);
    }
    for (const p of result.problems) log(redact(`intent: ${p}`).slice(0, 300));
    log(
      `intent: ${result.intent.criteria.length} criteria from ${ticket.ref}${recording ? " and its recording" : ""}`,
    );
    return result.intent;
  };

  /**
   * The PR's criteria (§17.2): each ticket it names, then its own criteria. One source keeps its
   * criteria as they are; several are merged, renumbered and tagged with their source.
   */
  const readIntent = async (bundle: ContextBundle, models: ModelPort): Promise<CriterionSet> => {
    const parts: IntentPart[] = [];
    for (const source of intentSources(bundle)) {
      parts.push({ source: source.source, set: await readSource(source, models) });
    }
    return parts.length === 1 ? parts[0]!.set : mergeIntents(parts);
  };

  // §19 step 0: the bundle's ticket and recording become the criteria, unless the Cloud reused an
  // intent version; the diff maps them to the files the PR changed. Without a bundle or a model
  // key, the demo's fixture criteria stand in (stub.ts).
  const bundle = job.bundleUrl ? await fetchBundle(job.bundleUrl) : null;
  const models = deps.models ?? (deps.metaKey ? metaModelPort({ apiKey: deps.metaKey }) : null);
  let intent = job.intent;
  if (!intent && bundle && models) intent = await readIntent(bundle, models);
  intent ??= stubIntent();
  let coverage: CoverageMap = { items: [], routes: [] };
  if (bundle && models && intent.criteria.length > 0 && bundle.diff.files.length > 0) {
    const mapped = await mapCoverage(models, intent.criteria, bundle.diff);
    spend(COVERAGE_MODEL, mapped.usage);
    for (const p of mapped.problems) log(redact(`coverage: ${p}`));
    coverage = mapped.coverage;
  }
  await client.send({ kind: "intent_ready", intent, coverage });
  const coverageOf = (id: string) => coverage.items.find((i) => i.criterionId === id)?.status;

  const hookPath = job.config.isolation.session_hook;
  const hookSecret = job.secrets?.hookSecret;
  const bypass = job.secrets?.bypass;

  const identity = hookPath && hookSecret ? { hookPath, secret: hookSecret } : undefined;

  // §19 step 1: a PR preview that doesn't answer ends the job (preflight.ts). A base preview that
  // doesn't only costs the baseline: the run goes on without one, as when there's none (§17.3).
  let baseUrl = job.baseUrl;
  if (recorder.preflight) {
    const pr = await recorder.preflight({ origin: job.prUrl, ...(bypass && { bypass }) });
    if (!pr.ok) {
      throw new PreviewUnreachable(redact(`the preview ${job.prUrl} didn't answer: ${pr.problem}`));
    }
    const base = baseUrl
      ? await recorder.preflight({ origin: baseUrl, ...(bypass && { bypass }) })
      : null;
    if (base && !base.ok) {
      log(redact(`the base preview ${baseUrl} didn't answer (${base.problem}): no baseline`));
      baseUrl = null;
    }
  }
  const cache = new PathCache(job.cachedPaths);
  /** The path each criterion was recorded along, for the aria diff's routes and targets (§24). */
  const usedPaths = new Map<string, SavedPath>();

  const store =
    deps.store ??
    ((lane: LaneResult, file: Parameters<NonNullable<VerifyDeps["store"]>>[1]) =>
      uploadTake(client, lane, job.runId, file));

  /** Records one side, uploads its video and returns the redacted lane, or null if it crashed. */
  const recordSide = async (
    side: "pr" | "base",
    origin: string,
    criterion: Criterion,
    path: SavedPath,
  ): Promise<Side | null> => {
    try {
      const { lane, video, judge, boxTrack } = await recorder.record({
        side,
        origin,
        criterion,
        path,
        ...(identity && { identity }),
        ...(bypass && { bypass }),
      });
      let cited = lane;
      if (video) {
        const body = readFileSync(video.humanFile);
        const human = { name: "human.mp4", contentType: "video/mp4", body };
        const humanVideo = await store(lane, human);
        cited = { ...lane, humanVideo, videoOffsets: video.offsets };
      }
      log(`${criterion.id} ${side}: ${lane.status}, ${video ? "video uploaded" : "no video"}`);
      // Nothing a page or a tool said about a secret leaves the worker, the judges included.
      const reported = JSON.parse(redact(JSON.stringify(cited))) as LaneResult;
      return {
        lane: reported,
        judge: {
          lane: reported,
          ...(judge?.video && { judgeVideo: judge.video }),
          ...(judge?.annotatedShot && { annotatedShot: judge.annotatedShot }),
        },
        ...(video &&
          boxTrack && {
            evidence: { humanFile: video.humanFile, humanOffsetMs: video.offsets.human, boxTrack },
          }),
      };
    } catch (err) {
      if (err instanceof StaleJobError) throw err;
      log(redact(`${criterion.id} ${side}: not recorded: ${(err as Error).message}`));
      return null;
    }
  };

  // The PR's test hints steer the navigator: its start page, and test data added to the repo's.
  const hints = bundle?.hints;
  const navConfig = hints
    ? {
        ...job.config,
        start: { ...job.config.start, default: hints.start ?? job.config.start.default },
        data: [...job.config.data, ...hints.data],
      }
    : job.config;

  /** The navigator's run, with a crash (a lane that wouldn't open) counted as setup_failed. */
  const explore = async (criterion: Criterion): Promise<ExploreResult> => {
    try {
      const result = await recorder.explore!({
        origin: job.prUrl,
        criterion,
        config: navConfig,
        ...(identity && { identity }),
        ...(bypass && { bypass }),
      });
      spend(NAVIGATOR_MODEL, result.usage);
      return result;
    } catch (err) {
      if (err instanceof StaleJobError) throw err;
      const reason = redact(`the navigator crashed: ${(err as Error).message}`).slice(0, 300);
      return { status: "setup_failed", reason, steps: [], ms: 0, usage: NO_TOKENS, modelCalls: 0 };
    }
  };

  /** §19 3: the PR side by its cached path, by exploring, or by its fixture; then the base side. */
  const recordBoth = async (criterion: Criterion) => {
    let pr: Side | null = null;
    let base: Side | null = null;
    let path: SavedPath | null;
    let notFound: Exclude<ExploreResult, { status: "found" }> | undefined;
    if (recorder.explore) {
      // §19 3a–b: the cached path, else explore; a cached path that breaks is explored again.
      const outcome = await recordWithPath<Side | null>({
        cached: cache.get(criterion.id),
        explore: () => explore(criterion),
        record: (p) => recordSide("pr", job.prUrl, criterion, p),
        laneOf: (side) => side?.lane ?? { status: "error" },
      });
      if (outcome.kind === "recorded") {
        path = outcome.path;
        pr = outcome.recording;
        if (outcome.explored) {
          cache.put(path);
          await client.send({ kind: "path_saved", path });
        }
        log(`${criterion.id}: path from ${outcome.source}, take ${outcome.take}`);
      } else {
        path = null;
        notFound = outcome.explored;
        pr = outcome.recording ?? null;
        cache.discard(criterion.id);
        log(redact(`${criterion.id}: ${notFound.status}: ${notFound.reason}`));
      }
      if (path && baseUrl) base = await recordSide("base", baseUrl, criterion, path);
    } else {
      path = pathFor(criterion.id, job.cachedPaths);
      if (path) {
        pr = await recordSide("pr", job.prUrl, criterion, path);
        if (baseUrl) base = await recordSide("base", baseUrl, criterion, path);
      }
    }
    if (path) usedPaths.set(criterion.id, path);
    return { pr, base, path, notFound };
  };

  /** §22 and §19 e: judged on the first take; re-recorded once to confirm a fail or break a tie. */
  const judge = async (criterion: Criterion, recorded: Awaited<ReturnType<typeof recordBoth>>) => {
    const ask = (pr: Side) =>
      queue.run(async () => {
        await client.alive();
        const judged = await judgeCriterion(
          judges!,
          criterion,
          pr.judge,
          recorded.base?.judge ?? null,
          coverageOf(criterion.id),
        );
        for (const call of judged.calls) {
          spend(call.model, call.usage);
          if (!call.ok)
            log(
              redact(`${criterion.id} ${call.judge}: no answer: ${call.error ?? ""}`).slice(0, 300),
            );
        }
        log(`${criterion.id}: judged ${judged.combined.verdict} (${judged.combined.reason})`);
        return judged;
      });
    let pr = recorded.pr!;
    const first = await ask(pr);
    let judged: Judged = first;
    const why = rerecordFor(first.combined);
    if (why && recorded.path) {
      log(
        `${criterion.id}: ${why === "confirm_fail" ? "confirming the fail" : "breaking the tie"}: recording the PR side again`,
      );
      const again = await slots.run(() => recordSide("pr", job.prUrl, criterion, recorded.path!));
      if (again) {
        const second = await ask(again);
        pr = again;
        judged = {
          ...second,
          combined: afterRerecord(first.combined, first.checked, second.combined),
        };
      }
    }
    return { pr, verdict: verdictOf(criterion, judged, judges!, pr.lane.tTriggerMs) };
  };

  const verifyOne = async (criterion: Criterion): Promise<Verdict> => {
    await client.alive(); // a superseded job stops here (StaleJobError)
    const recorded = await slots.run(() => recordBoth(criterion));
    let pr = recorded.pr;
    let verdict: Verdict;
    if (!judges) {
      verdict = recordedVerdict(criterion.id, pr?.lane ?? null, recorded.notFound);
    } else if (!pr) {
      const why = recorded.notFound;
      verdict = why
        ? notJudged(
            criterion.id,
            REASONS[why.status],
            `Not judged: the navigator couldn't reach the trigger (${why.status}: ${why.reason}).`,
          )
        : notJudged(criterion.id, "infra_error", "Not judged: the PR side wasn't recorded.");
    } else {
      const judged = await judge(criterion, recorded);
      pr = judged.pr;
      verdict = judged.verdict;
    }
    const lanes = [pr?.lane, recorded.base?.lane].filter((l): l is LaneResult => Boolean(l));
    await client.send({ kind: "criterion_verdict", verdict, lanes });
    if (judges && pr) await sendEvidence(criterion, verdict, pr);
    return verdict;
  };

  /**
   * §19 step 4, §23: the GIF and still of a judged criterion, cut from the take its verdict rests
   * on over the evidence window, the watched element outlined. A failure here costs the report its
   * GIF, never the verdict.
   */
  const sendEvidence = async (criterion: Criterion, verdict: Verdict, pr: Side) => {
    const source = pr.evidence;
    const window = verdict.evidenceWindow;
    const tt = pr.lane.tTriggerMs;
    if (
      !recorder.evidence ||
      !source ||
      !window ||
      tt === null ||
      verdict.verdict === "inconclusive"
    )
      return;
    // §28: a private repo's pages never go to the public store.
    const evidenceStore = job.evidenceStore ?? "private";
    // The element the readings watched, as the box track names it (§20.4: element watch targets).
    const label = outlinedLabel(source.boxTrack, window);
    // §23, T5.2: a visual criterion's highlight is SAM's mask of what it's about, when the job
    // can call Meta's models; otherwise, or when SAM has nothing, the element's box.
    const segment =
      criterion.kind === "ui_visual" && models && deps.metaKey
        ? samSegmenter({ port: models, apiKey: deps.metaKey, criterion })
        : undefined;
    try {
      const rendered = await slots.run(() =>
        recorder.evidence!({
          humanVideo: source.humanFile,
          humanOffsetMs: source.humanOffsetMs,
          window,
          tTriggerMs: tt,
          boxTrack: source.boxTrack,
          label,
          caption: redact(captionOf(criterion.id, verdict.verdict, verdict.observed)),
          ...(segment && { segment }),
        }),
      );
      if (rendered.segmentation) {
        spent += rendered.segmentation.costUsd;
        log(
          redact(
            `${criterion.id}: SAM ${rendered.segmentation.outcome}, ${rendered.segmentation.detail}`,
          ).slice(0, 300),
        );
      }
      // Beside the take's video: the take its verdict rests on (after a re-record, the second).
      const take = Number(/\/take-(\d+)\//.exec(pr.lane.humanVideo?.path ?? "")?.[1]) || undefined;
      const gif = await store(pr.lane, {
        name: "evidence.gif",
        contentType: "image/gif",
        body: readFileSync(rendered.gif),
        store: evidenceStore,
        ...(take && { take }),
      });
      const still = await store(pr.lane, {
        name: "evidence.png",
        contentType: "image/png",
        body: readFileSync(rendered.still),
        store: evidenceStore,
        ...(take && { take }),
      });
      await client.send({ kind: "criterion_evidence", criterionId: criterion.id, gif, still });
      log(
        `${criterion.id}: evidence GIF, ${rendered.width} px at ${rendered.fps} fps, ${Math.round(rendered.bytes / 1024)} KB`,
      );
    } catch (err) {
      if (err instanceof StaleJobError) throw err;
      log(redact(`${criterion.id}: no evidence GIF: ${(err as Error).message}`).slice(0, 300));
    }
  };

  /**
   * §24, T5.6: what the PR changed on the criteria's routes that no criterion explains. After the
   * verdicts, one route at a time; anything that goes wrong costs the report its ⚠️ lines, never
   * the run. A run of some criteria only (/intenzo rerun) doesn't look.
   */
  const detectChanges = async () => {
    if (!recorder.snapshot || !models || job.only) return;
    const skipped = skipChanges({
      baseUrl,
      baseDrift: job.baseDrift ?? null,
      baseIsolated: identity !== undefined,
    });
    if (skipped) {
      log(`changes: skipped, ${skipped}`);
      return;
    }
    const paths = [...usedPaths.values()];
    const routes = changeRoutes(paths, coverage.routes, job.config.start.default);
    const targets = changeTargets(paths);
    const found: UnrequestedChange[] = [];
    try {
      for (const route of routes) {
        const snap = (origin: string): Promise<RouteSnapshot> =>
          slots.run(() =>
            recorder.snapshot!({
              origin,
              route,
              targets,
              ...(identity && { identity }),
              ...(bypass && { bypass }),
            }),
          );
        const base = await snap(baseUrl!);
        const pr = await snap(job.prUrl);
        const hunks = dropExpected(
          diffSnapshots(base.lines, pr.lines),
          { base: base.touched, pr: pr.touched },
          base.lines,
          pr.lines,
        );
        const classified = await classifyChanges(models, {
          route,
          criteria: intent.criteria,
          hunks,
        });
        spent += classified.costUsd;
        if (classified.error) log(redact(`changes: ${route}: ${classified.error}`).slice(0, 300));
        found.push(...classified.changes);
        log(
          `changes: ${route}: ${hunks.length} change(s) the criteria don't touch, ${classified.changes.length} unrequested`,
        );
      }
      await client.send({ kind: "changes_done", changes: reportable(found) });
    } catch (err) {
      if (err instanceof StaleJobError) throw err;
      log(redact(`changes: not checked: ${(err as Error).message}`).slice(0, 300));
    }
  };

  const criteria = intent.criteria.filter((c) => !job.only || job.only.includes(c.id));
  const verdicts = await Promise.all(criteria.map(verifyOne));
  await detectChanges();
  // The tickets decide the run; a PR's own criteria are reported, never counted (§17.2).
  const counted = new Set(intent.criteria.filter(countsTowardOutcome).map((c) => c.id));
  const deciding = verdicts.filter((v) => counted.has(v.criterionId));
  return {
    outcome: judges ? aggregateOutcome(deciding) : stubOutcome(deciding),
    costUsd: spent,
  };
}

/** The bundle the Cloud stored for the run (§8), through its signed URL. */
async function fetchBundle(url: string): Promise<ContextBundle> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`the context bundle: HTTP ${response.status}`);
  return ContextBundle.parse(await response.json());
}

/** Downloads the PM's recording from its signed URL, then transcribes and encodes it (§18). */
function readRecordingFrom(apiKey: string): (url: string) => Promise<TicketVideo> {
  return async (url) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const dir = mkdtempSync(join(tmpdir(), "intenzo-ticket-"));
    try {
      const file = join(dir, "recording.mp4");
      writeFileSync(file, new Uint8Array(await response.arrayBuffer()));
      return await prepareTicketVideo(file, { apiKey });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

/** How an error names an intent source: "ticket #5", "the PR's own criteria"… */
function sourceName(ref: string): string {
  if (ref === "PR") return "the PR's own criteria";
  if (ref === "PR body") return "the PR's description";
  return `ticket ${ref}`;
}

/** §22.4 over the judges' verdicts; no criteria at all is inconclusive. */
function aggregateOutcome(verdicts: readonly Verdict[]): RunOutcome {
  if (verdicts.some((v) => v.verdict === "fail")) return "fail";
  if (verdicts.length === 0 || verdicts.some((v) => v.verdict === "inconclusive"))
    return "inconclusive";
  return "pass";
}
