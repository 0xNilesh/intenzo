import { describe, expect, it } from "vitest";

import { actionsFor, checkRunPayload } from "./check-run.ts";
import { cell, MAX_COMMENT_CHARS, renderComment } from "./comment.ts";
import { aggregate, type ReportCriterion, type ReportModel } from "./model.ts";

// The demo ticket's four criteria (fixtures/criteria), on the almost-right branch: C2 fails.
const criterion = (id: string, text: string, expected: string): ReportCriterion => ({
  id,
  text,
  expected,
  verdict: "pass",
  reasonCode: "agreed",
  observed: "As expected.",
  clip: { startMs: 4_000, endMs: 8_000 },
  readings: null,
});
const C = [
  criterion("C1", "SAVE10 takes 10% off the cart", "The discount line shows −$5.00"),
  criterion(
    "C2",
    "The total drops 10% to $45.00 right away, with no refresh",
    "The order total changes from $50.00 to $45.00 within 1 s of applying SAVE10",
  ),
  criterion(
    "C3",
    "An expired code shows a clear message",
    'The message "This code has expired" appears',
  ),
  criterion("C4", "The savings chart shows the 10% slice", "The chart shows a 10% slice"),
];

const model = (
  overrides: Partial<ReportModel> = {},
  run: Partial<ReportModel["run"]> = {},
): ReportModel => ({
  groupId: 2,
  ticket: { ref: "#5", title: "Discount codes" },
  run: {
    id: "4f4cf15f-0000-4000-8000-000000000001",
    headSha: "40028b4aa",
    attemptNo: 1,
    state: "done",
    outcome: "pass",
    outcomeReason: null,
    baseline: { sha: "b6b60c7dde", drift: 0 },
    judges: ["Spark Open", "Spark 1.3"],
    durationMs: 112_000,
    costUsd: 0.31,
    ...run,
  },
  criteria: C,
  reportUrl: "https://intenzo-cloud.vercel.app/r/4f4cf15f-0000-4000-8000-000000000001",
  history: [],
  policy: { inconclusive: "neutral", agentHandle: "@intenzo-fixer", agentAttemptsLeft: 3 },
  ...overrides,
});

const failing = model(
  {
    criteria: C.map((c) =>
      c.id === "C2"
        ? {
            ...c,
            verdict: "fail" as const,
            observed: "The total stayed $50.00 after Apply and only changed after a reload.",
            readings: "+0 s $50.00 · +1 s $50.00 · +3 s $50.00 · after reload $45.00",
          }
        : c,
    ),
    history: [{ headSha: "af1065e11", attemptNo: 1, outcome: "superseded" }],
  },
  { outcome: "fail" },
);

describe("renderComment (§26.1)", () => {
  // The rendered comments are files, so they read as GitHub will show them.
  it.each<[string, ReportModel]>([
    ["pass", model()],
    ["fail", failing],
    [
      "inconclusive",
      model(
        {
          criteria: C.map((c) =>
            c.id === "C4"
              ? {
                  ...c,
                  verdict: "inconclusive" as const,
                  reasonCode: "judges_disagree" as const,
                  observed: "One judge saw the slice, one didn't.",
                }
              : c,
          ),
        },
        { outcome: "inconclusive" },
      ),
    ],
    [
      "superseded",
      model(
        { criteria: [] },
        { outcome: "superseded", baseline: null, durationMs: null, costUsd: null },
      ),
    ],
    [
      "waiting",
      model(
        { criteria: [] },
        {
          state: "waiting_inputs",
          outcome: null,
          baseline: null,
          judges: [],
          durationMs: null,
          costUsd: null,
        },
      ),
    ],
    [
      // §26.1 stage 2: the criteria are listed as soon as the intent is ready, before any verdict.
      "criteria-listed",
      model(
        {
          criteria: C.map((c) => ({
            ...c,
            verdict: null,
            reasonCode: null,
            observed: null,
            clip: null,
            readings: null,
          })),
        },
        { state: "verifying", outcome: null, durationMs: null, costUsd: null, judges: [] },
      ),
    ],
    [
      "verifying",
      model(
        {
          criteria: C.map((c, i) =>
            i < 2 ? c : { ...c, verdict: null, reasonCode: null, observed: null, clip: null },
          ),
        },
        { state: "verifying", outcome: null, durationMs: null, costUsd: null },
      ),
    ],
    [
      "preview-not-ready",
      model(
        { criteria: [] },
        {
          outcome: "inconclusive",
          outcomeReason: "preview_not_ready",
          baseline: null,
          judges: [],
          durationMs: null,
          costUsd: null,
        },
      ),
    ],
  ])("%s", async (name, m) => {
    await expect(renderComment(m)).toMatchFileSnapshot(`./__snapshots__/comment.${name}.md`);
  });

  it("shows a failed criterion's GIF inline, and keeps the clip link for the others (§26.1)", () => {
    const gif =
      "https://klfpiscdv04whptv.public.blob.vercel-storage.com/runs/r/C2/pr/take-1/evidence.gif";
    const text = renderComment({
      ...failing,
      criteria: failing.criteria.map((c) => ({ ...c, gif: c.id === "C2" ? gif : `${gif}?other` })),
    });
    expect(text).toContain(
      `| ❌ | **C2** The total drops 10% to $45.00 right away, with no refresh | ![C2](${gif}) |`,
    );
    expect(text).toContain("| ✅ | **C1** SAVE10 takes 10% off the cart | [▶ 0:04–0:08]");
  });

  it("shows a visual criterion's GIF inline when it passes too: SAM's highlight is its evidence (T5.2)", () => {
    const gif = "https://store.public.blob.example/runs/r/C4/pr/take-1/evidence.gif";
    const text = renderComment({
      ...failing,
      criteria: failing.criteria.map((c) =>
        c.id === "C4" ? { ...c, gif, visual: true } : { ...c, gif: `${gif}?${c.id}` },
      ),
    });
    expect(text).toContain(`| ✅ | **C4** The savings chart shows the 10% slice | ![C4](${gif}) |`);
    // A passing criterion that isn't visual keeps its clip link.
    expect(text).toContain("| ✅ | **C1** SAVE10 takes 10% off the cart | [▶ 0:04–0:08]");
  });

  it("starts with the group's marker, so a lost comment id can be found again", () => {
    expect(renderComment(model()).startsWith("<!-- intenzo:run-group:2 -->\n")).toBe(true);
  });

  it("drops collapsed sections, the last first, until it fits GitHub's 65,536 characters", () => {
    // Every cell is capped, so only the list of earlier runs can grow without bound.
    const runs = (n: number) =>
      Array.from({ length: n }, () => ({
        headSha: "0000000",
        attemptNo: 1,
        outcome: "superseded" as const,
      }));
    const long = model(
      {
        criteria: C.map((c) => ({ ...c, readings: "+0 s $50.00 " + "x".repeat(5_000) })),
        history: runs(4000),
      },
      { outcome: "fail" },
    );
    const text = renderComment(long);
    expect(text.length).toBeLessThanOrEqual(MAX_COMMENT_CHARS);
    expect(text).not.toContain("Earlier runs");
    expect(text).toContain("<summary>Readings</summary>");
    // The table and the footer survive whole.
    for (const c of C) expect(text).toContain(`**${c.id}**`);
    expect(text).toContain("Full report");
    // Short enough, nothing goes.
    expect(renderComment(model({ history: runs(3) }, { outcome: "fail" }))).toContain(
      "Earlier runs (3)",
    );
  });
});

describe("cell", () => {
  it.each([
    ["a | b", "a \\| b"],
    ["<img src=x onerror=alert(1)>", "&lt;img src=x onerror=alert(1)&gt;"],
    ["ping @octocat", "ping @​octocat"],
    ["line one\n\nline two", "line one line two"],
  ])("%j → %j", (text, out) => {
    expect(cell(text)).toBe(out);
  });

  it("cuts long text", () => {
    expect(cell("x".repeat(400), 300)).toHaveLength(300);
  });
});

describe("aggregate (§22.4)", () => {
  it.each([
    [["pass", "fail", "inconclusive"], "fail"],
    [["pass", "inconclusive"], "inconclusive"],
    [["pass", "pass"], "pass"],
    [["pass", null], null],
    [[], null],
  ] as const)("%j → %s", (verdicts, overall) => {
    expect(aggregate(verdicts)).toBe(overall);
  });
});

describe("checkRunPayload (§26.2)", () => {
  it("completes with the outcome's conclusion, the comment's table and its buttons", () => {
    const payload = checkRunPayload(failing);
    expect(payload).toMatchObject({
      status: "completed",
      conclusion: "failure",
      output: { title: "3/4 passed" },
      // GitHub's "Details" link opens the run's report, not the App's homepage.
      detailsUrl: failing.reportUrl,
    });
    expect(payload.output.summary).toContain("| ❌ | **C2**");
    expect(payload.actions.map((a) => a.identifier)).toEqual(["fix", "rerun"]);
  });

  it.each([
    ["pass", {}, ["approve", "rerun"]],
    ["fail", { agentHandle: null }, ["rerun"]],
    // §26.3: at max_agent_attempts the button is gone.
    ["fail", { agentAttemptsLeft: 0 }, ["rerun"]],
    ["inconclusive", {}, ["rerun"]],
    ["error", {}, []],
  ] as const)("offers %s %j: %j", (outcome, policy, identifiers) => {
    const m = model(
      {
        policy: {
          inconclusive: "neutral",
          agentHandle: "@intenzo-fixer",
          agentAttemptsLeft: 3,
          ...policy,
        },
      },
      { outcome },
    );
    expect(actionsFor(m).map((a) => a.identifier)).toEqual(identifiers);
  });

  it("never offers a button before the run completes", () => {
    const payload = checkRunPayload(model({}, { state: "verifying", outcome: null }));
    expect(payload).toMatchObject({ status: "in_progress", actions: [] });
    expect(payload.conclusion).toBeUndefined();
  });

  it("keeps GitHub's limits on the buttons", () => {
    for (const a of actionsFor(failing)) {
      expect(a.label.length).toBeLessThanOrEqual(20);
      expect(a.description.length).toBeLessThanOrEqual(40);
      expect(a.identifier.length).toBeLessThanOrEqual(20);
    }
  });

  it("closes an inconclusive run as the repo's policy says", () => {
    const m = model(
      { policy: { inconclusive: "failure", agentHandle: null, agentAttemptsLeft: 0 } },
      { outcome: "inconclusive" },
    );
    expect(checkRunPayload(m).conclusion).toBe("failure");
  });
});
