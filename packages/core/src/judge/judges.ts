import { metaModelPort, sparkOpenPort } from "../models/meta.ts";
import type { ModelPort, ModelUsage, ReasoningEffort } from "../models/port.ts";
import { JUDGE_JSON_SCHEMA, JUDGE_SYSTEM, JUDGE_V1, JudgeReply } from "../prompts/judge.v1.ts";
import type { Criterion, JudgeOutput, Verdict } from "../schema/index.ts";
import { judgeBundle, type JudgeSide } from "./bundle.ts";
import { capVerdict, type Checked, checkJudge, combine, type Combined, preJudge } from "./rules.ts";

// The two judges (ARCHITECTURE §4, §22): Spark Open on Baseten (A, the primary) and Spark 1.3 on
// the Meta Model API (B), each given exactly the same messages (§22.2), at reasoning effort low
// (DECISIONS 2026-10-30, T0.3: same accuracy, a third of the latency). Their answers go through
// the §22.3 checks and §22.1 caps; nothing a judge says is taken without them.

export interface Judge {
  /** "Spark Open", "Spark 1.3": shown in the report. */
  name: string;
  model: string;
  port: ModelPort;
  effort?: ReasoningEffort;
}

export const SPARK_OPEN_MODEL = "meta-models/muse-spark-open";
export const SPARK_13_MODEL = "muse-spark-1.3";
const JUDGE_EFFORT: ReasoningEffort = "low";
const MAX_TOKENS = 8192;
const TIMEOUT_MS = 90_000;

/**
 * The two judges from the environment: META_API_KEY for Spark 1.3, and BASETEN_API_KEY (or
 * SPARK_OPEN_BASE_URL + SPARK_OPEN_API_KEY on another host) for Spark Open; SPARK_OPEN_MODEL
 * overrides its model id. Null when either is missing: then nothing is judged.
 */
export function judgesFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): [Judge, Judge] | null {
  const metaKey = env.META_API_KEY ?? env.MODEL_API_KEY;
  const openBase = env.SPARK_OPEN_BASE_URL?.replace(/\/+$/, "");
  const openKey = openBase ? env.SPARK_OPEN_API_KEY : env.BASETEN_API_KEY;
  if (!metaKey || !openKey) return null;
  return [
    {
      name: "Spark Open",
      model: env.SPARK_OPEN_MODEL || SPARK_OPEN_MODEL,
      port: sparkOpenPort({ apiKey: openKey, ...(openBase && { baseUrl: openBase }) }),
      effort: JUDGE_EFFORT,
    },
    {
      name: "Spark 1.3",
      model: SPARK_13_MODEL,
      port: metaModelPort({ apiKey: metaKey }),
      effort: JUDGE_EFFORT,
    },
  ];
}

export interface JudgeCall {
  judge: string;
  model: string;
  ok: boolean;
  error?: string;
  usage: ModelUsage;
  ms: number;
}

export interface Judged {
  /** The verdict after the §22.3 checks and §22.1 caps. */
  combined: Combined;
  /** Each judge's own answer (null when it gave none, or wasn't asked). */
  outputs: [JudgeOutput | null, JudgeOutput | null];
  checked: [Checked, Checked];
  calls: JudgeCall[];
}

/**
 * Judges one criterion on one take (§22): decided without the judges when §22.1 says so, else
 * both judges in parallel on the same bundle, each checked against the PR lane's readings, then
 * combined and capped. Coverage lets a missing trigger fail only on code the PR touched.
 */
export async function judgeCriterion(
  judges: readonly [Judge, Judge],
  criterion: Criterion,
  pr: JudgeSide,
  base?: JudgeSide | null,
  coverage?: "covered" | "uncovered" | "unclear",
): Promise<Judged> {
  const pre = preJudge(criterion, pr.lane);
  if (pre) {
    const none: Checked = { verdict: "inconclusive", reason: pre.reason };
    return { combined: pre, outputs: [null, null], checked: [none, none], calls: [] };
  }
  const bundle = judgeBundle(criterion, pr, base);
  const messages = [
    { role: "system" as const, content: JUDGE_SYSTEM },
    { role: "user" as const, content: bundle.parts },
  ];
  const results = await Promise.all(
    judges.map((j) =>
      j.port.call({
        stage: "judge",
        model: j.model,
        promptVersion: JUDGE_V1,
        messages,
        schema: JudgeReply,
        jsonSchema: { name: "JudgeOutput", schema: JUDGE_JSON_SCHEMA },
        maxTokens: MAX_TOKENS,
        timeoutMs: TIMEOUT_MS,
        ...(j.effort && { reasoningEffort: j.effort }),
      }),
    ),
  );
  const outputs = results.map((r) => (r.ok ? r.output : null)) as [
    JudgeOutput | null,
    JudgeOutput | null,
  ];
  const checked = outputs.map((o) => checkJudge(o, criterion, pr.lane.readings)) as [
    Checked,
    Checked,
  ];
  return {
    combined: capVerdict(combine(checked[0], checked[1]), pr.lane, coverage),
    outputs,
    checked,
    calls: results.map((r, i) => ({
      judge: judges[i]!.name,
      model: judges[i]!.model,
      ok: r.ok,
      ...(!r.ok && { error: r.error }),
      usage: r.usage,
      ms: r.ms,
    })),
  };
}

/**
 * The criterion's Verdict (§7) from its judging: the evidence window is the PR take's
 * [Tt − 1 s, Tt + 3 s] (§22.3), and `observed` is the primary judge's account, else the other's.
 */
export function verdictOf(
  criterion: Pick<Criterion, "id">,
  judged: Judged,
  judges: readonly [Judge, Judge],
  tTriggerMs: number | null,
): Verdict {
  const answered = judged.outputs.flatMap((o, i) => (o ? [{ ...o, model: judges[i]!.name }] : []));
  const observed =
    answered[0]?.observed ??
    (judged.combined.reason === "agreed"
      ? ""
      : `Not judged: ${judged.combined.reason.replaceAll("_", " ")}.`);
  return {
    criterionId: criterion.id,
    verdict: judged.combined.verdict,
    reasonCode: judged.combined.reason,
    evidenceWindow:
      tTriggerMs === null ? null : { startMs: tTriggerMs - 1000, endMs: tTriggerMs + 3000 },
    observed,
    judges: answered,
  };
}
