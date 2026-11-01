import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LaneResult } from "@intenzo/core";
import { afterAll, describe, expect, it } from "vitest";

import {
  asVerdict,
  confirmLone,
  diffMessages,
  diffVerdict,
  framesParts,
  readingsParts,
} from "./arms.ts";
import { loadTicket } from "./case.ts";
import { capLone, parseJudgeArgs } from "./judge.ts";
import { ResultRow, Results } from "./results.ts";

const ticket = loadTicket("discount");
const criterion = ticket.criteria.find((c) => c.id === "C2")!;
const T0 = 1_900_000_000_000;
const lane = (
  status: LaneResult["status"] = "completed",
  isolation: LaneResult["isolation"] = "ephemeral_user",
) =>
  LaneResult.parse({
    criterionId: "C2",
    side: "pr",
    status,
    laneStartMs: T0,
    tTriggerMs: status === "completed" ? T0 + 2000 : null,
    stepLog:
      status === "completed"
        ? [
            {
              tMs: T0 + 2000,
              step: { op: "click", target: { by: "role", role: "button", name: "Apply" } },
              ok: true,
              trigger: true,
            },
          ]
        : [],
    readings: [
      {
        i: 0,
        label: "order total",
        kind: "text",
        phase: "pre",
        tMs: T0 + 1000,
        value: "$50.00",
        bbox: [0, 0, 10, 10],
      },
    ],
    consoleErrorCount: 0,
    failedRequestCount: 0,
    isolation,
  });
const diff = {
  base: "83d338a2ec3c0609c4addbd60e4a8fd76a23860a",
  head: "2be43410000000000000000000000000000000000",
  files: [
    {
      path: "app/cart/page.tsx",
      status: "modified" as const,
      additions: 3,
      deletions: 1,
      patch: "+ const total = useMemo(() => sum(lines), [lines]);",
    },
  ],
};

const dir = mkdtempSync(join(tmpdir(), "intentbench-arms-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("arm inputs", () => {
  it("A has the ticket and the diff, and nothing from the browser", () => {
    const messages = diffMessages(ticket.text, criterion, diff);
    const all = messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
    expect(messages.every((m) => typeof m.content === "string")).toBe(true); // no media parts
    expect(all).toContain(criterion.expected);
    expect(all).toContain("useMemo");
    expect(all).toContain('<untrusted source="ticket">');
    for (const browserOnly of ["READINGS", "STEP LOG", "BASELINE", "$50.00 |"])
      expect(all).not.toContain(browserOnly);
  });

  it("B is the judge bundle's text with no image or video", () => {
    const parts = readingsParts(criterion, lane(), null);
    expect(parts.map((p) => p.type)).toEqual(["text"]);
    expect(parts[0]!.type === "text" && parts[0]!.text).toContain("READINGS");
  });

  it("C adds the stills as images, and no video", () => {
    const stills = [1, 2].map((n) => {
      const file = join(dir, `${n}.jpg`);
      writeFileSync(file, Buffer.from([0xff, 0xd8, n]));
      return file;
    });
    const parts = framesParts(criterion, lane(), null, stills);
    expect(parts.map((p) => p.type)).toEqual(["text", "text", "image_url", "image_url"]);
    expect(parts.some((p) => p.type === "video_url")).toBe(false);
    expect(parts[2]!.type === "image_url" && parts[2]!.image_url.url).toMatch(
      /^data:image\/jpeg;base64,/,
    );
  });

  it("caps arm A's diff so a huge patch can't blow the prompt up", () => {
    const huge = { ...diff, files: [{ ...diff.files[0]!, patch: "x".repeat(100_000) }] };
    const user = diffMessages(ticket.text, criterion, huge)[1]!.content as string;
    expect(user.length).toBeLessThan(30_000);
    expect(user).toContain("… (cut)");
  });
});

describe("lone-judge verdicts", () => {
  it("lets a lone judge's pass or fail stand, and calls its own inconclusive unsure", () => {
    expect(asVerdict({ verdict: "fail", reason: null })).toEqual({
      verdict: "fail",
      reason: "agreed",
    });
    expect(asVerdict({ verdict: "inconclusive", reason: null })).toEqual({
      verdict: "inconclusive",
      reason: "unsure",
    });
    expect(asVerdict({ verdict: "inconclusive", reason: "contradicts_readings" })).toEqual({
      verdict: "inconclusive",
      reason: "contradicts_readings",
    });
  });

  it("confirms a fail on the second take, else it's flaky (§19 e)", () => {
    const fail = { verdict: "fail", reason: "agreed" } as const;
    const pass = { verdict: "pass", reason: "agreed" } as const;
    expect(confirmLone(fail, fail)).toEqual(fail);
    expect(confirmLone(fail, pass)).toEqual({ verdict: "inconclusive", reason: "flaky" });
    expect(confirmLone(pass, null)).toEqual(pass);
    expect(confirmLone(fail, null)).toEqual(fail);
  });

  it("applies §22.1's caps: a missing trigger can't pass, and no isolation caps everything", () => {
    const pass = { verdict: "pass", reason: "agreed" } as const;
    expect(capLone(pass, lane("trigger_absent"))).toEqual({
      verdict: "inconclusive",
      reason: "precondition_unmet",
    });
    expect(capLone({ verdict: "fail", reason: "agreed" }, lane("trigger_absent"))).toEqual({
      verdict: "fail",
      reason: "agreed",
    });
    expect(capLone(pass, lane("completed", "none"))).toEqual({
      verdict: "inconclusive",
      reason: "no_isolation",
    });
  });

  it("reads arm A's answer, with a failed call as infra_error", () => {
    expect(diffVerdict({ verdict: "pass", observed: "" })).toEqual({
      verdict: "pass",
      reason: "agreed",
    });
    expect(diffVerdict({ verdict: "inconclusive", observed: "" })).toEqual({
      verdict: "inconclusive",
      reason: "unsure",
    });
    expect(diffVerdict(null)).toEqual({ verdict: "inconclusive", reason: "infra_error" });
  });
});

describe("results", () => {
  const row = {
    arm: "D",
    judge: "dual",
    caseId: "discount-almost-right",
    criterionId: "C2",
    kind: "almost_right",
    split: "heldout",
    label: "fail",
    repeat: 1,
    verdict: "fail",
    reason: "agreed",
    rerecorded: true,
    calls: 4,
    usd: 0.031,
    ms: 21000,
    pack: "ab".repeat(32),
  };

  it("accepts a well-formed row and file", () => {
    expect(ResultRow.safeParse(row).success).toBe(true);
    const file = {
      startedAt: "2026-11-01T10:00:00.000Z",
      split: "heldout",
      arms: ["D"],
      repeats: { ABC: 3, D: 2 },
      rows: [row],
      totals: { calls: 4, usd: 0.031, ms: 21000 },
      stoppedAtCap: false,
    };
    expect(Results.safeParse(file).success).toBe(true);
  });

  it("refuses an unknown arm, judge or reason, and extra fields", () => {
    expect(ResultRow.safeParse({ ...row, arm: "E" }).success).toBe(false);
    expect(ResultRow.safeParse({ ...row, judge: "wonder" }).success).toBe(false);
    expect(ResultRow.safeParse({ ...row, reason: "vibes" }).success).toBe(false);
    expect(ResultRow.safeParse({ ...row, note: "x" }).success).toBe(false);
  });
});

describe("parseJudgeArgs", () => {
  it("defaults to the held-out split, every arm, 3 repeats (2 for D) and a $2.50 cap", () => {
    expect(parseJudgeArgs([])).toEqual({
      split: "heldout",
      arms: ["A", "B", "C", "D"],
      repeats: 3,
      dRepeats: 2,
      maxUsd: 2.5,
    });
    expect(parseJudgeArgs(["--arms=b,d", "--only=discount", "--max-usd=0.2"])).toMatchObject({
      arms: ["B", "D"],
      only: "discount",
      maxUsd: 0.2,
    });
    expect(() => parseJudgeArgs(["--arms=E"])).toThrow(/unknown arm/);
    expect(() => parseJudgeArgs(["--repeats=9"])).toThrow(/--repeats/);
  });
});
