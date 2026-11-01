// The report model (core/report) from the database: what the comment, the check run and the report
// page show for a run group. The run shown is the latest one that wasn't superseded (§16.4).
import {
  CriterionSet,
  type LaneResult,
  UnrequestedChange,
  type ReasonCode,
  type ReportCriterion,
  type ReportModel,
  type VerdictValue,
} from "@intenzo/core";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { billingUnits } from "../billing/meter.ts";
import type { Db } from "../db/db.ts";
import { repoConfig } from "../db/repos.ts";
import { criteriaResults, intentVersions, outbox, repos, runGroups, runs } from "../db/schema.ts";

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
/**
 * §26.1's readings line: what the criterion's watched element read after the trigger, timed from
 * it ("+0 s $50.00 · +1 s $50.00 · +3 s $50.00 · after reload $45.00"). The first element the lane
 * watched is the one; a lane that watched no element shows what appeared in its live regions
 * (a toast), and a lane where nothing changed shows nothing. Region snapshots are left to the
 * report: they're too long for a line.
 */
export function readingsLine(lane: LaneResult): string | null {
  const parts = readingParts(lane).map((p) => p.value);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** readingsLine()'s readings one by one, with their labels: "order total", "+1 s $50.00" (§26.3). */
export function readingParts(lane: LaneResult): { label: string; value: string }[] {
  const t0 = lane.tTriggerMs;
  // Stored JSON: tolerate a lane without readings rather than fail the whole report.
  const readings = (lane.readings ?? []).filter((r) => r.phase !== "pre");
  const element = readings.find((r) => r.kind === "text")?.label;
  const shown = element
    ? readings.filter((r) => r.label === element && r.kind !== "region_diff")
    : readings.filter((r) => r.label === "live regions" && r.value && r.value !== "no change");
  return shown.map((r) => {
    const when =
      r.phase === "after_reload"
        ? "after reload"
        : t0 === null
          ? ""
          : `+${Math.round((r.tMs - t0) / 1000)} s`;
    const value = r.kind === "absent" ? "(absent)" : (r.value ?? "").split("\n")[0];
    return { label: r.label, value: `${when} ${value}`.trim() };
  });
}

const PublicRef = z.object({ store: z.literal("public"), path: z.string().min(1) });
/** runs.changes_json, as the worker sent it (changes_done, §24). */
const UnrequestedChanges = z.array(UnrequestedChange);

/** The evidence GIF's URL, when the worker sent one and the public store is known. */
function gifOf(stored: unknown, publicFile?: PublicFile): string | null {
  const ref = PublicRef.safeParse(stored);
  return ref.success && publicFile ? publicFile(ref.data.path) : null;
}

/**
 * §26.3: Send to agent presses left. The button only exists for agent_trigger: button (auto posts
 * by itself), and only while the group has used fewer than max_agent_attempts.
 */
export function agentAttemptsLeft(
  policy: { agent_handle?: string; agent_trigger: "button" | "auto"; max_agent_attempts: number },
  used: number,
): number {
  if (!policy.agent_handle || policy.agent_trigger !== "button") return 0;
  return Math.max(0, policy.max_agent_attempts - used);
}

/** §26.3: the run's fix request, if Send to agent was pressed for it. */
async function agentRequestOf(db: Db, runId: string, max: number) {
  const [row] = await db
    .select({ payload: outbox.payloadJson })
    .from(outbox)
    .where(and(eq(outbox.effect, "agent"), eq(outbox.runId, runId)))
    .limit(1);
  const attempt = (row?.payload as { attempt?: number } | undefined)?.attempt;
  return attempt ? { attempt, max } : null;
}

/** §26.2: who approved the run, in order (the outbox's approval rows). */
async function approversOf(db: Db, runId: string): Promise<string[]> {
  const rows = await db
    .select({ payload: outbox.payloadJson })
    .from(outbox)
    .where(and(eq(outbox.effect, "approval"), eq(outbox.runId, runId)))
    .orderBy(outbox.id);
  return rows.map((r) => (r.payload as { login: string }).login);
}

/** A public file's URL by its path (§28: GIFs and stills go to the public store). */
export type PublicFile = (path: string) => string | null;

function reportCriterion(
  c: { id: string; text: string; expected: string; kind: string },
  result: ResultRow | undefined,
  publicFile?: PublicFile,
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
    gif: gifOf(evidence.gif, publicFile),
    ...(c.kind === "ui_visual" && { visual: true }),
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
  publicFile?: PublicFile,
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
          publicFile,
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
    ticket: ctx.group.ticketRef
      ? { ref: ctx.group.ticketRef, title: ctx.group.ticketTitle ?? "" }
      : null,
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
      agentAttemptsLeft: agentAttemptsLeft(config.policy, ctx.group.agentAttempts),
    },
    agentRequest: await agentRequestOf(db, run.id, config.policy.max_agent_attempts),
    approvedBy: await approversOf(db, run.id),
    billing: { judgedRuns: ctx.group.judgedRuns, units: billingUnits(ctx.group.judgedRuns) },
    unrequestedChanges: (UnrequestedChanges.safeParse(run.changesJson).data ?? []).map((c) => ({
      route: c.route,
      description: c.description,
    })),
  };
}
