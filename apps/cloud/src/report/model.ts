// The report model (core/report) from the database: what the comment, the check run and the report
// page show for a run group. The run shown is the latest one that wasn't superseded (§16.4).
import {
  CriterionSet,
  type LaneResult,
  type ReasonCode,
  type ReportCriterion,
  type ReportModel,
  type VerdictValue,
} from "@intenzo/core";
import { and, eq } from "drizzle-orm";

import type { Db } from "../db/db.ts";
import { repoConfig } from "../db/repos.ts";
import { criteriaResults, intentVersions, repos, runGroups, runs } from "../db/schema.ts";

type RunRow = typeof runs.$inferSelect;
type ResultRow = typeof criteriaResults.$inferSelect;

/** What criterion_verdict and criterion_evidence leave in criteria_results.evidence_json. */
export interface StoredEvidence {
  window?: { startMs: number; endMs: number } | null;
  observed?: string;
  gif?: unknown;
  still?: unknown;
}

/** The run a group's comment shows: the latest that wasn't superseded, else the latest. */
export function shownRun(groupRuns: readonly RunRow[]): RunRow | undefined {
  const latest = [...groupRuns].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return latest.find((r) => r.outcome !== "superseded") ?? latest[0];
}

/** The PR lane's readings in a line: "+0 s $50.00 · +1 s $50.00 · after reload $45.00". */
export function readingsLine(lane: LaneResult): string | null {
  const t0 = lane.tTriggerMs;
  // Stored JSON: tolerate a lane without readings rather than fail the whole report.
  const parts = (lane.readings ?? [])
    .filter((r) => r.phase !== "pre" && r.kind !== "absent")
    .map((r) => {
      const when =
        r.phase === "after_reload"
          ? "after reload"
          : t0 === null
            ? ""
            : `+${Math.round((r.tMs - t0) / 1000)} s`;
      return `${when} ${r.value ?? ""}`.trim();
    });
  return parts.length > 0 ? parts.join(" · ") : null;
}

function reportCriterion(
  c: { id: string; text: string; expected: string },
  result: ResultRow | undefined,
): ReportCriterion {
  const evidence = (result?.evidenceJson ?? {}) as StoredEvidence;
  const lanes = (result?.lanesJson ?? []) as LaneResult[];
  const pr = lanes.find((l) => l.side === "pr");
  // §21.4: a file's ms = canonical ms + its offset.
  const offset = pr?.videoOffsets?.human;
  const window = evidence.window;
  const clip =
    window && offset !== undefined && pr?.humanVideo
      ? { startMs: window.startMs + offset, endMs: window.endMs + offset }
      : null;
  return {
    id: c.id,
    text: c.text,
    expected: c.expected,
    verdict: (result?.verdict as VerdictValue | undefined) ?? null,
    reasonCode: (result?.reasonCode as ReasonCode | undefined) ?? null,
    observed: evidence.observed ?? null,
    clip,
    readings: pr ? readingsLine(pr) : null,
  };
}

/**
 * The group's report. A check run belongs to one run, so it asks for that run (`runId`); the
 * comment shows the run shownRun() picks.
 */
export async function reportModel(
  db: Db,
  groupId: number,
  reportBaseUrl: string,
  runId?: string,
): Promise<ReportModel | null> {
  const [ctx] = await db
    .select({ group: runGroups, repo: repos })
    .from(runGroups)
    .innerJoin(repos, eq(runGroups.repoId, repos.id))
    .where(eq(runGroups.id, groupId));
  if (!ctx) return null;
  const groupRuns = await db.select().from(runs).where(eq(runs.runGroupId, groupId));
  const run = runId ? groupRuns.find((r) => r.id === runId) : shownRun(groupRuns);
  if (!run) return null;

  let criteria: ReportCriterion[] = [];
  if (run.intentVersionId !== null) {
    const [intent] = await db
      .select()
      .from(intentVersions)
      .where(eq(intentVersions.id, run.intentVersionId));
    const parsed = CriterionSet.safeParse(intent?.intentJson);
    const results = await db
      .select()
      .from(criteriaResults)
      .where(eq(criteriaResults.runId, run.id));
    if (parsed.success) {
      criteria = parsed.data.criteria.map((c) =>
        reportCriterion(
          c,
          results.find((r) => r.criterionId === c.id),
        ),
      );
    }
  }
  const judges = new Set<string>();
  const judged = await db
    .select({ judges: criteriaResults.judgesJson })
    .from(criteriaResults)
    .where(and(eq(criteriaResults.runId, run.id)));
  for (const { judges: list } of judged) {
    for (const j of (list ?? []) as { model?: string }[]) if (j.model) judges.add(j.model);
  }

  const config = repoConfig(ctx.repo);
  const finished = run.finishedAt ?? null;
  return {
    groupId,
    ticket: null,
    run: {
      id: run.id,
      headSha: run.headSha,
      attemptNo: run.attemptNo,
      state: run.state,
      outcome: run.outcome,
      outcomeReason: run.outcomeReason,
      baseline:
        run.baseSha && run.baseDrift !== null ? { sha: run.baseSha, drift: run.baseDrift } : null,
      judges: [...judges],
      durationMs: run.startedAt && finished ? finished.getTime() - run.startedAt.getTime() : null,
      costUsd: run.costUsd,
    },
    criteria,
    reportUrl: `${reportBaseUrl.replace(/\/$/, "")}/r/${run.id}`,
    history: [...groupRuns]
      .filter((r) => r.id !== run.id)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((r) => ({ headSha: r.headSha, attemptNo: r.attemptNo, outcome: r.outcome })),
    policy: {
      inconclusive: config.policy.inconclusive_conclusion,
      agentHandle: config.policy.agent_handle ?? null,
    },
  };
}
