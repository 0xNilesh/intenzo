// The verify job (§19), with stub verdicts until the navigator (P3) and the judges (P4): the demo
// ticket's criteria (fixtures/criteria) are each recorded along their hand-written path
// (fixtures/paths) on the PR preview and, when the run has one, the base preview. The people's
// videos are uploaded (§28) and each criterion gets the stub's fixed verdict, citing the PR
// recording's evidence window, unless the PR side didn't complete (§22.1).
import { readFileSync } from "node:fs";

import {
  type ArtifactRef,
  type Criterion,
  type LaneResult,
  type ReasonCode,
  type RunOutcome,
  SavedPath,
  takePath,
  type Verdict,
  type VerifyJob,
} from "@intenzo/core";

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

export interface Recorder {
  record(input: LaneInput): Promise<RecordedLane>;
  close(): Promise<void>;
}

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
export function recordedVerdict(criterionId: string, pr: LaneResult | null): Verdict {
  const fixed = stubVerdict(criterionId);
  if (pr?.status === "completed" && pr.tTriggerMs !== null) {
    const tt = pr.tTriggerMs;
    return { ...fixed, evidenceWindow: { startMs: tt - 1000, endMs: tt + 3000 } };
  }
  const observed = pr
    ? `Not judged: the PR recording ended "${pr.status}".`
    : "Not judged: the PR side wasn't recorded.";
  const reasonCode = pr && pr.status !== "completed" ? REASONS[pr.status] : "infra_error";
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

  for (const criterion of intent.criteria) {
    if (job.only && !job.only.includes(criterion.id)) continue;
    await client.alive(); // a superseded job stops here (StaleJobError)
    const path = pathFor(criterion.id, job.cachedPaths);
    const lanes: LaneResult[] = [];
    for (const [side, origin] of sides) {
      if (!path) break; // nothing to record until the navigator finds a path (P3)
      try {
        const { lane, video } = await recorder.record({
          side,
          origin,
          criterion,
          path,
          ...(hookPath && hookSecret && { identity: { hookPath, secret: hookSecret } }),
          ...(bypass && { bypass }),
        });
        let cited = lane;
        if (video) {
          const body = readFileSync(video.humanFile);
          const human = { name: "human.mp4", contentType: "video/mp4", body };
          const humanVideo = await uploadTake(client, lane, job.runId, human);
          cited = { ...lane, humanVideo, videoOffsets: video.offsets };
        }
        // Nothing a page or a tool said about a secret leaves the worker.
        lanes.push(JSON.parse(redact(JSON.stringify(cited))) as LaneResult);
        log(`${criterion.id} ${side}: ${lane.status}, ${video ? "video uploaded" : "no video"}`);
      } catch (err) {
        if (err instanceof StaleJobError) throw err;
        log(redact(`${criterion.id} ${side}: not recorded: ${(err as Error).message}`));
      }
    }
    const verdict = recordedVerdict(criterion.id, lanes.find((l) => l.side === "pr") ?? null);
    verdicts.push(verdict);
    await client.send({ kind: "criterion_verdict", verdict, lanes });
  }
  return stubOutcome(verdicts);
}
