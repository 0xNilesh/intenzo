import { describe, expect, it } from "vitest";

import { CLIPS } from "../clips.ts";
import { JUDGE_JSON_SCHEMA, JUDGE_SYSTEM, renderBundle } from "./prompt.ts";
import { JudgeOutput, type Lane } from "./schema.ts";

const T0 = 1_000_000;
const lane: Lane = {
  clipId: "total-stale",
  laneStartMs: T0,
  tTriggerMs: T0 + 1023,
  stepLog: [
    { tMs: T0 + 312, step: { op: "goto", path: "/cart" }, ok: true, trigger: false },
    {
      tMs: T0 + 905,
      step: { op: "fill", target: { by: "testId", id: "discount-input" }, value: "SAVE10" },
      ok: true,
      trigger: false,
    },
    {
      tMs: T0 + 1023,
      step: { op: "click", target: { by: "testId", id: "apply" } },
      ok: true,
      trigger: true,
    },
    { tMs: T0 + 4400, step: { op: "reload" }, ok: true, trigger: false },
  ],
  readings: [
    {
      i: 0,
      label: "order total",
      kind: "text",
      phase: "pre",
      tMs: T0 + 990,
      value: "$50.00",
      bbox: [1, 2, 3, 4],
    },
    {
      i: 1,
      label: "live regions",
      kind: "text",
      phase: "pre",
      tMs: T0 + 995,
      value: "",
      bbox: null,
    },
    {
      i: 2,
      label: "order total",
      kind: "text",
      phase: "post",
      tMs: T0 + 1024,
      value: "$50.00",
      bbox: [1, 2, 3, 4],
    },
    {
      i: 3,
      label: "live regions",
      kind: "region_diff",
      phase: "post",
      tMs: T0 + 1030,
      value: "+ status: Discount SAVE10 applied\n+ alert: Oops",
      bbox: null,
    },
    {
      i: 4,
      label: "error message",
      kind: "absent",
      phase: "post",
      tMs: T0 + 2030,
      value: null,
      bbox: null,
    },
  ],
  consoleErrorCount: 0,
  failedRequestCount: 2,
};

describe("judge.v1 bundle", () => {
  const criterion = CLIPS.find((c) => c.id === "total-stale")!.criterion;
  const text = renderBundle(criterion, lane);
  const lines = text.split("\n");

  it("keeps ticket and page text inside untrusted blocks (§13, §29)", () => {
    const ticket = text.slice(text.indexOf('<untrusted source="ticket">'));
    expect(ticket.slice(0, ticket.indexOf("</untrusted>"))).toContain(criterion.text);
    const page = text.slice(text.indexOf('<untrusted source="page">'));
    expect(page.slice(0, page.indexOf("</untrusted>"))).toContain(
      "+ status: Discount SAVE10 applied",
    );
  });

  it("states the criterion's timing and persistence", () => {
    expect(lines).toContain("timingMs: 1000 · persistence: true · watched: order total");
  });

  it("logs steps in lane ms and marks the trigger with Tt", () => {
    expect(lines).toContain('t=905  fill [data-testid=discount-input] with "SAVE10"');
    expect(lines).toContain("t=1023  click [data-testid=apply]   ← TRIGGER (Tt = 1023)");
    expect(lines).toContain("t=4400  reload the page");
  });

  it("lists every reading by index, with post times relative to Tt", () => {
    expect(lines).toContain("0 | order total | text | pre | 990 | $50.00");
    expect(lines).toContain("1 | live regions | text | pre | 995 | (empty)");
    expect(lines).toContain("2 | order total | text | post | 1024 (Tt+1) | $50.00");
    expect(lines).toContain("4 | error message | absent | post | 2030 (Tt+1007) | —");
  });

  it("puts each line of a multi-line diff on its own row, so each can be cited", () => {
    const at = lines.indexOf(
      "3 | live regions | region_diff | post | 1030 (Tt+7) | + status: Discount SAVE10 applied",
    );
    expect(at).toBeGreaterThan(-1);
    expect(lines[at + 1]).toBe("  | | | | | + alert: Oops");
  });

  it("reports console errors and failed requests, and that there's no baseline", () => {
    expect(lines).toContain("Console errors around the trigger: 0 · failed requests: 2");
    expect(text).toContain("Baseline: none");
  });

  it("never names the planted behavior", () => {
    expect(text.toLowerCase()).not.toMatch(/variant|stale|correct build/);
    expect(JUDGE_SYSTEM.toLowerCase()).not.toMatch(/variant|stale|planted/);
  });
});

describe("the strict JSON schema for Spark 1.3", () => {
  it("has exactly the JudgeOutput keys, all required, nothing else allowed", () => {
    const keys = Object.keys(JudgeOutput.shape);
    expect(Object.keys(JUDGE_JSON_SCHEMA.properties)).toEqual(keys);
    expect(JUDGE_JSON_SCHEMA.required).toEqual(keys);
    expect(JUDGE_JSON_SCHEMA.additionalProperties).toBe(false);
  });
});
