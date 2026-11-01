import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LaneResult } from "@intenzo/core";
import { judgeBundle, PR_VIDEO_HEADING } from "@intenzo/core/judge";
import type { ContentPart, ModelMessage } from "@intenzo/core/models";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type ArmSide,
  armParts,
  BASE_STILLS_HEADING,
  NO_MEDIA_NOTE,
  PR_STILLS_HEADING,
  sideOf,
} from "./arms.ts";
import { loadTicket } from "./case.ts";
import { renderDiff, reviewMessages } from "./review.ts";

const T0 = 1_793_000_000_000;
const ticket = loadTicket("discount");
const C2 = ticket.criteria.find((c) => c.id === "C2")!;
// A value only the page shows, so a leak of browser data into arm A would show.
const ONLY_ON_PAGE = "$41.17";
const lane = (side: "pr" | "base", status = "completed") =>
  LaneResult.parse({
    criterionId: "C2",
    side,
    status,
    laneStartMs: T0,
    tTriggerMs: status === "completed" ? T0 + 1000 : null,
    stepLog: [
      {
        tMs: T0 + 1000,
        step: { op: "click", target: { by: "role", role: "button", name: "Apply" } },
        ok: status === "completed",
        trigger: true,
      },
    ],
    readings: [
      {
        i: 0,
        label: "order total",
        kind: "text",
        phase: "post",
        tMs: T0 + 2000,
        value: ONLY_ON_PAGE,
        bbox: null,
      },
    ],
    consoleErrorCount: 0,
    failedRequestCount: 0,
    isolation: "ephemeral_user",
    ...(status !== "completed" && { failedStepIndex: 0 }),
  });
const diff = [
  {
    path: "lib/discount.ts",
    status: "added" as const,
    additions: 2,
    deletions: 0,
    patch: "+export const SAVE10 = 0.1;\n+export const total = (lines) => sum(lines);",
  },
];

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "intentbench-arms-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A take's folder with its files, and two fake stills, as ArmSide. */
function side(name: string, status = "completed"): ArmSide {
  const folder = join(dir, name);
  mkdirSync(folder, { recursive: true });
  for (const f of ["judge.mp4", "shot-annotated.png", "s1.jpg", "s2.jpg"])
    writeFileSync(join(folder, f), `${name} ${f}`);
  const take = {
    lane: lane(name === "base" ? "base" : "pr", status),
    judgeVideo: "judge.mp4",
    humanVideo: "human.mp4",
    annotatedShot: "shot-annotated.png",
    offsets: { human: 0, judge: 0 },
  };
  return { ...sideOf(folder, take), stills: [join(folder, "s1.jpg"), join(folder, "s2.jpg")] };
}
const kinds = (parts: ContentPart[]) => parts.map((p) => p.type);
const textOf = (messages: ModelMessage[]) => messages.map((m) => m.content).join("\n");

describe("arm A, diff-only", () => {
  const messages = reviewMessages(ticket.text, diff, C2);

  it("has the ticket, the diff and the criterion, and no browser data", () => {
    expect(messages.every((m) => typeof m.content === "string")).toBe(true);
    const text = textOf(messages);
    expect(text).toContain("SAVE10 takes 10% off the subtotal");
    expect(text).toContain("+export const total = (lines) => sum(lines);");
    expect(text).toContain(`CRITERION C2`);
    expect(text).toContain(`Expected: ${C2.expected}`);
    expect(text).toContain("timingMs: 1000");
    for (const browserOnly of [ONLY_ON_PAGE, "READINGS", "STEP LOG", "TRIGGER", "BASELINE"])
      expect(text).not.toContain(browserOnly);
  });

  it("puts the criterion last, so a case's criteria share their prefix", () => {
    const other = reviewMessages(ticket.text, diff, ticket.criteria[0]!);
    const user = messages[1]!.content as string;
    const prefix = user.slice(0, user.indexOf("CRITERION"));
    expect((other[1]!.content as string).startsWith(prefix)).toBe(true);
  });

  it("cuts a diff too long to send, and says so", () => {
    // 50,000 characters each: the first fits under the 60,000 cap, the next two don't.
    const big = { ...diff[0]!, patch: "+x".repeat(25_000) };
    const text = renderDiff([big, { ...big, path: "b.ts" }, { ...big, path: "c.ts" }]);
    expect(text).toContain("--- lib/discount.ts (added, +2 −0)");
    expect(text).toContain("(2 more changed file(s) not shown: the diff is too long)");
  });
});

describe("arms B, C and D", () => {
  it("D is the worker's bundle: the annotated still and both videos", () => {
    const [pr, base] = [side("pr-1"), side("base")];
    const parts = armParts("D", C2, pr, base);
    expect(parts).toEqual(judgeBundle(C2, pr, base).parts);
    expect(kinds(parts).filter((k) => k === "video_url")).toHaveLength(2);
  });

  it("B has no images: the same text as D, and a note that there's no media", () => {
    const [pr, base] = [side("pr-1"), side("base")];
    const parts = armParts("B", C2, pr, base);
    expect(kinds(parts)).toEqual(["text", "text"]);
    expect(parts[0]).toEqual(armParts("D", C2, pr, base)[0]);
    expect(parts[1]).toEqual({ type: "text", text: NO_MEDIA_NOTE });
  });

  it("C swaps each video for its stills, and keeps D's text and annotated still", () => {
    const [pr, base] = [side("pr-1"), side("base")];
    const parts = armParts("C", C2, pr, base);
    const d = armParts("D", C2, pr, base);
    expect(kinds(parts)).toEqual([
      "text",
      "text",
      "image_url",
      "text",
      "image_url",
      "image_url",
      "text",
      "image_url",
      "image_url",
    ]);
    expect(parts.slice(0, 3)).toEqual(d.slice(0, 3));
    expect(parts[3]).toEqual({ type: "text", text: PR_STILLS_HEADING });
    expect(parts[6]).toEqual({ type: "text", text: BASE_STILLS_HEADING });
    const decoded = (p: ContentPart) =>
      p.type === "image_url"
        ? Buffer.from(p.image_url.url.split(",")[1]!, "base64").toString()
        : "";
    expect(decoded(parts[4]!)).toBe("pr-1 s1.jpg");
    expect(decoded(parts[8]!)).toBe("base s2.jpg");
    expect(parts.some((p) => p.type === "text" && p.text === PR_VIDEO_HEADING)).toBe(false);
  });

  it("C leaves out the base's stills when its lane didn't complete, as D leaves its video", () => {
    const [pr, base] = [side("pr-1"), side("base", "trigger_absent")];
    expect(kinds(armParts("D", C2, pr, base)).filter((k) => k === "video_url")).toHaveLength(1);
    const parts = armParts("C", C2, pr, base);
    expect(parts.filter((p) => p.type === "text" && p.text === BASE_STILLS_HEADING)).toEqual([]);
    expect(kinds(parts).filter((k) => k === "image_url")).toHaveLength(3);
  });

  it("finds a take's files in its folder, and leaves out the ones it has none of", () => {
    const take = {
      lane: lane("pr"),
      judgeVideo: null,
      humanVideo: null,
      annotatedShot: "shot-annotated.png",
      offsets: null,
    };
    expect(sideOf("/packs/x/C2/pr-1", take)).toEqual({
      lane: take.lane,
      annotatedShot: "/packs/x/C2/pr-1/shot-annotated.png",
    });
  });
});
