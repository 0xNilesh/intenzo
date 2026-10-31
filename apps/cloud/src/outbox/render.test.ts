import { describe, expect, it } from "vitest";

import type { runGroups, runs } from "../db/schema.ts";
import type { OutcomeReason } from "../runs/transition.ts";
import { checkRunFields, commentBody } from "./render.ts";

const AT = new Date("2026-10-31T09:00:00.000Z");
const run = (fields: Partial<typeof runs.$inferSelect>): typeof runs.$inferSelect => ({
  id: "00000000-0000-4000-8000-000000000001",
  runGroupId: 3,
  headSha: "b4e35b0f00d",
  attemptNo: 1,
  trigger: "opened",
  state: "waiting_inputs",
  outcome: null,
  outcomeReason: null,
  prUrl: null,
  baseUrl: null,
  baseSha: null,
  baseDrift: null,
  intentVersionId: null,
  coverageJson: null,
  currentJobId: null,
  modalCallId: null,
  checkRunId: null,
  createdAt: AT,
  startedAt: null,
  deadlineAt: null,
  finishedAt: null,
  costUsd: null,
  timingsJson: null,
  ...fields,
});
const done = (
  outcome: NonNullable<typeof runs.$inferSelect.outcome>,
  reason: OutcomeReason | null = null,
) => run({ state: "done", outcome, outcomeReason: reason, finishedAt: AT });

describe("checkRunFields", () => {
  it.each([
    [run({}), "queued", undefined, "Waiting for the preview"],
    [
      run({ state: "verifying", prUrl: "https://p", startedAt: AT }),
      "in_progress",
      undefined,
      "Verifying the preview",
    ],
    [done("pass"), "completed", "success", "Verified"],
    [done("fail"), "completed", "failure", "Not verified"],
    [done("inconclusive", "preview_not_ready"), "completed", "neutral", "Inconclusive"],
    [done("error", "deadline_passed"), "completed", "neutral", "Intenzo failed"],
    [done("cancelled"), "completed", "cancelled", "Cancelled"],
    [done("superseded"), "completed", "neutral", "Superseded"],
  ] as const)("%#: %s → %s %s, %s", (row, status, conclusion, title) => {
    const fields = checkRunFields(row, "neutral");
    expect(fields).toMatchObject({ status, output: { title } });
    expect(fields.conclusion).toBe(conclusion);
  });

  it("closes an inconclusive run as the repo's policy says (§22.5)", () => {
    expect(checkRunFields(done("inconclusive"), "failure").conclusion).toBe("failure");
  });
});

describe("commentBody", () => {
  const group = { id: 3 } as typeof runGroups.$inferSelect;

  it("shows the latest run that wasn't superseded, with its baseline", () => {
    const body = commentBody(group, [
      run({ state: "done", outcome: "superseded", createdAt: new Date(AT.getTime() - 60_000) }),
      run({
        headSha: "c5f46c1aa",
        attemptNo: 2,
        state: "verifying",
        prUrl: "https://demo-shop-x.vercel.app",
        baseUrl: "https://demo-shop-main.vercel.app",
        baseSha: "b6b60c7dde",
        baseDrift: 2,
      }),
    ]);
    expect(body).toBe(
      "<!-- intenzo:run-group:3 -->\n### Intenzo\n\n" +
        "🔎 Verifying `c5f46c1` (attempt 2) on [its preview](https://demo-shop-x.vercel.app). " +
        "Baseline: `b6b60c7` (2 commits before the merge base).\n",
    );
  });

  it("says why a run ended without verdicts", () => {
    const body = commentBody(group, [done("inconclusive", "preview_failed")]);
    expect(body).toContain("⚠️ `b4e35b0` wasn't verified: its preview failed to deploy.");
  });
});
