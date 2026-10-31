// The verify job (§19), with stub verdicts until the judges (P4): the demo ticket's criteria
// (fixtures/criteria) are each recorded on the PR preview and, when the run has one, the base
// preview. With the navigator (a recorder that can explore, T3.5), each PR side replays the run
// group's cached path or explores for one (§19 3a–b), and new paths go back to the Cloud as
// path_saved; without it, the hand-written paths (fixtures/paths) are used. The people's
// videos are uploaded (§28) and each criterion gets the stub's fixed verdict, citing the PR
// recording's evidence window, unless the PR side didn't complete (§22.1).
import { readFileSync } from "node:fs";

import {
  type ArtifactRef,
  type Criterion,
  type IntenzoConfig,
  type LaneResult,
  type ReasonCode,
  type RunOutcome,
  SavedPath,
  takePath,
  type Verdict,
  type VerifyJob,
} from "@intenzo/core";
import { PathCache, recordWithPath, type ExploreResult } from "@intenzo/core/navigator";

import { type JobClient, StaleJobError } from "./client.ts";
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
  /** human.mp4 on disk and both videos' offsets (§21.4), when the video could be made. */
  video: { humanFile: string; offsets: { human: number; judge: number } } | null;
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
  /** Explores the PR app for a criterion's trigger (§20.3), when the worker has the navigator. */
  explore?(input: ExploreInput): Promise<ExploreResult>;
  close(): Promise<void>;
}

const NO_TOKENS = { promptTokens: 0, cachedTokens: 0, completionTokens: 0, reasoningTokens: 0 };
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

/** Uploads one file of a take into the first take number no earlier job of the run has used. */
async function uploadTake(
  client: JobClient,
  lane: LaneResult,
  runId: string,
  file: { name: string; contentType: string; body: Uint8Array<ArrayBuffer> },
): Promise<ArtifactRef> {
  for (let take = 1; take <= MAX_TAKES; take++) {
    const path = takePath(runId, lane.criterionId, lane.side, take, file.name);
    try {
      const [ref] = await uploadArtifacts(client, [
        { store: "private", path, contentType: file.contentType, body: file.body },
      ]);
      return ref!;
    } catch (err) {
      if (!/already exists/i.test(String(err))) throw err;
    }
  }
  throw new Error(`no free take for ${lane.criterionId} ${lane.side} in ${MAX_TAKES} tries`);
}

export async function verify(
  job: VerifyJob,
  client: JobClient,
  recorder: Recorder,
  log: (line: string) => void,
): Promise<RunOutcome> {
  const redact = redactor(job.secrets);
  const intent = job.intent ?? stubIntent();
  await client.send({ kind: "intent_ready", intent, coverage: { items: [], routes: [] } });

  const sides = [
    ["pr", job.prUrl],
    ...(job.baseUrl ? [["base", job.baseUrl] as const] : []),
  ] as const;
  const hookPath = job.config.isolation.session_hook;
  const hookSecret = job.secrets?.hookSecret;
  const bypass = job.secrets?.bypass;
  const verdicts: Verdict[] = [];

  const identity = hookPath && hookSecret ? { hookPath, secret: hookSecret } : undefined;
  const cache = new PathCache(job.cachedPaths);

  /** Records one side, uploads its video and returns the redacted lane, or null if it crashed. */
  const recordSide = async (
    side: "pr" | "base",
    origin: string,
    criterion: Criterion,
    path: SavedPath,
  ): Promise<LaneResult | null> => {
    try {
      const { lane, video } = await recorder.record({
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
        const humanVideo = await uploadTake(client, lane, job.runId, human);
        cited = { ...lane, humanVideo, videoOffsets: video.offsets };
      }
      log(`${criterion.id} ${side}: ${lane.status}, ${video ? "video uploaded" : "no video"}`);
      // Nothing a page or a tool said about a secret leaves the worker.
      return JSON.parse(redact(JSON.stringify(cited))) as LaneResult;
    } catch (err) {
      if (err instanceof StaleJobError) throw err;
      log(redact(`${criterion.id} ${side}: not recorded: ${(err as Error).message}`));
      return null;
    }
  };

  /** The navigator's run, with a crash (a lane that wouldn't open) counted as setup_failed. */
  const explore = async (criterion: Criterion): Promise<ExploreResult> => {
    try {
      return await recorder.explore!({
        origin: job.prUrl,
        criterion,
        config: job.config,
        ...(identity && { identity }),
        ...(bypass && { bypass }),
      });
    } catch (err) {
      if (err instanceof StaleJobError) throw err;
      const reason = redact(`the navigator crashed: ${(err as Error).message}`).slice(0, 300);
      return { status: "setup_failed", reason, steps: [], ms: 0, usage: NO_TOKENS, modelCalls: 0 };
    }
  };

  for (const criterion of intent.criteria) {
    if (job.only && !job.only.includes(criterion.id)) continue;
    await client.alive(); // a superseded job stops here (StaleJobError)
    const lanes: LaneResult[] = [];
    let path: SavedPath | null;
    let notFound: Exclude<ExploreResult, { status: "found" }> | undefined;

    if (recorder.explore) {
      // §19 3a–b: the cached path, else explore; a cached path that breaks is explored again.
      const outcome = await recordWithPath<LaneResult | null>({
        cached: cache.get(criterion.id),
        explore: () => explore(criterion),
        record: (p) => recordSide("pr", job.prUrl, criterion, p),
        laneOf: (lane) => lane ?? { status: "error" },
      });
      if (outcome.kind === "recorded") {
        path = outcome.path;
        if (outcome.recording) lanes.push(outcome.recording);
        if (outcome.explored) {
          cache.put(path);
          await client.send({ kind: "path_saved", path });
        }
        log(`${criterion.id}: path from ${outcome.source}, take ${outcome.take}`);
      } else {
        path = null;
        notFound = outcome.explored;
        if (outcome.recording) lanes.push(outcome.recording);
        cache.discard(criterion.id);
        log(redact(`${criterion.id}: ${notFound.status}: ${notFound.reason}`));
      }
      if (path && job.baseUrl) {
        const base = await recordSide("base", job.baseUrl, criterion, path);
        if (base) lanes.push(base);
      }
    } else {
      path = pathFor(criterion.id, job.cachedPaths);
      for (const [side, origin] of sides) {
        if (!path) break; // no hand-written path for this criterion
        const lane = await recordSide(side, origin, criterion, path);
        if (lane) lanes.push(lane);
      }
    }
    const verdict = recordedVerdict(
      criterion.id,
      lanes.find((l) => l.side === "pr") ?? null,
      notFound,
    );
    verdicts.push(verdict);
    await client.send({ kind: "criterion_verdict", verdict, lanes });
  }
  return stubOutcome(verdicts);
}
