import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LaneResult, SavedPath } from "@intenzo/core";
import type { ExploreResult } from "@intenzo/core/navigator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadCases } from "./case.ts";
import {
  formatManifest,
  manifestOf,
  missingPacks,
  Pack,
  packDir,
  readDiff,
  readPack,
  type Take,
} from "./pack.ts";
import { type Lab, recordAll } from "./recorder.ts";

const T0 = 1_793_000_000_000;
const SECRET = "hook-secret-value";
const limitCases = loadCases().filter((c) => c.ticket === "limit");
const broken = limitCases.filter((c) => c.id === "limit-broken");
const pathFor = (criterionId: string): SavedPath => ({
  criterionId,
  setup: [{ op: "goto", path: "/cart" }],
  trigger: [{ op: "click", target: { by: "role", role: "button", name: "Increase quantity" } }],
  watch: [{ label: "cart", scope: "region", target: { by: "testId", id: "cart" } }],
  portable: true,
});
const laneFor = (criterionId: string, side: "pr" | "base"): LaneResult => ({
  criterionId,
  side,
  status: "completed",
  laneStartMs: T0,
  tTriggerMs: T0 + 1000,
  stepLog: [
    {
      tMs: T0 + 1000,
      step: { op: "click", target: { by: "role", role: "button", name: "Increase quantity" } },
      ok: true,
      trigger: true,
    },
  ],
  readings: [],
  consoleErrorCount: 0,
  failedRequestCount: 0,
  isolation: "ephemeral_user",
});
const take = (criterionId: string, side: "pr" | "base"): Take => ({
  lane: laneFor(criterionId, side),
  judgeVideo: "judge.mp4",
  humanVideo: "human.mp4",
  annotatedShot: "shot-annotated.png",
  offsets: { human: -120, judge: -620 },
});
// 1,000 fresh prompt tokens and 100 output tokens of Wonder: $0.006.
const usage = { promptTokens: 1000, cachedTokens: 0, completionTokens: 100, reasoningTokens: 0 };

/** A lab that finds every trigger, except where `notFound` or `crashOn` says otherwise. */
function fakeLab(options: { notFound?: string[]; crashOn?: string[] } = {}) {
  const calls = { explore: [] as string[], record: [] as string[], diff: [] as string[] };
  const lab: Lab = {
    async explore({ origin, criterion }): Promise<ExploreResult> {
      const key = `${new URL(origin).hostname.split(".")[0]}/${criterion.id}`;
      calls.explore.push(key);
      const base = { steps: [], ms: 1200, usage, modelCalls: 4 };
      return options.notFound?.includes(key)
        ? { status: "setup_failed", reason: `the page asked for ${SECRET}`, ...base }
        : { status: "found", path: pathFor(criterion.id), ...base };
    },
    async record({ origin, side, criterion, outDir }) {
      const key = `${new URL(origin).hostname.split(".")[0]}/${criterion.id}`;
      calls.record.push(`${key}/${side}`);
      if (options.crashOn?.includes(key)) throw new Error(`Chromium crashed, header ${SECRET}`);
      mkdirSync(outDir, { recursive: true });
      for (const f of ["judge.mp4", "human.mp4", "shot-annotated.png"]) {
        writeFileSync(join(outDir, f), `${key} ${side} ${f}`);
      }
      return take(criterion.id, side);
    },
    async diff(branch) {
      calls.diff.push(branch);
      return { base: "b".repeat(40), head: "h".repeat(40), files: [] };
    },
  };
  return { lab, calls };
}

let dir: string;
let lines: string[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "intentbench-packs-"));
  lines = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const run = (lab: Lab, cases = limitCases) =>
  recordAll(cases, {
    dir,
    lab,
    // Each case's preview is named after it, so the fake lab can tell them apart.
    originOf: (c) => `https://${c.id}.preview.test`,
    baseOrigin: "https://base.preview.test",
    log: (line) => lines.push(line),
    redact: (text) => text.replaceAll(SECRET, "[redacted]"),
    now: () => new Date("2026-11-01T12:00:00.000Z"),
  });

describe("Pack (§31's evidence pack)", () => {
  const found = {
    caseId: "limit-correct",
    criterionId: "C1",
    recordedAt: "2026-11-01T12:00:00.000Z",
    origin: "https://limit-correct.preview.test",
    baseOrigin: "https://base.preview.test",
    explore: { status: "found", reason: null, modelCalls: 4, ms: 1200, costUsd: 0.006 },
    path: pathFor("C1"),
    takes: { pr: [take("C1", "pr"), take("C1", "pr")], base: take("C1", "base") },
  };

  it("holds the path, two PR takes and a base take", () => {
    expect(Pack.parse(found).takes?.pr).toHaveLength(2);
  });

  it("needs both PR takes (§19 e re-records once)", () => {
    const one = { ...found, takes: { ...found.takes, pr: [take("C1", "pr")] } };
    expect(Pack.safeParse(one).success).toBe(false);
  });

  it("keeps a failed exploration as a row with no takes, never with some", () => {
    const failed = {
      ...found,
      explore: { ...found.explore, status: "setup_failed", reason: "the cart didn't load" },
    };
    expect(Pack.safeParse({ ...failed, path: null, takes: null }).success).toBe(true);
    expect(Pack.safeParse(failed).success).toBe(false);
    expect(Pack.safeParse({ ...found, path: null, takes: null }).success).toBe(false);
  });

  it("rejects a path recorded for another criterion", () => {
    expect(Pack.safeParse({ ...found, path: pathFor("C2") }).success).toBe(false);
  });
});

describe("recordAll", () => {
  it("explores each criterion once, then records two PR takes and one base take", async () => {
    const { lab, calls } = fakeLab();
    const summary = await run(lab);

    expect(summary).toMatchObject({ recorded: 9, skipped: 0, crashed: [] });
    expect(summary.costUsd).toBeCloseTo(9 * 0.006, 10);
    expect(calls.explore).toHaveLength(9);
    // Two PR takes on the case's preview, one base take on the base's.
    expect(calls.record).toHaveLength(27);
    expect(calls.record.filter((r) => r.startsWith("limit-correct/C1/"))).toEqual([
      "limit-correct/C1/pr",
      "limit-correct/C1/pr",
    ]);
    expect(calls.record.filter((r) => r === "base/C1/base")).toHaveLength(3);
    const pack = readPack(dir, "limit-correct", "C1")!;
    expect(pack.explore).toEqual({
      status: "found",
      reason: null,
      modelCalls: 4,
      ms: 1200,
      costUsd: 0.006,
    });
    expect(pack.takes?.base.lane.side).toBe("base");
    const folder = packDir(dir, "limit-correct", "C1");
    expect(readFileSync(join(folder, "base", "judge.mp4"), "utf8")).toBe("base/C1 base judge.mp4");
    expect(
      readFileSync(join(packDir(dir, "limit-correct", "C1"), "pr-2", "judge.mp4"), "utf8"),
    ).toBe("limit-correct/C1 pr judge.mp4");
    expect(calls.diff).toEqual(limitCases.map((c) => c.branch));
    expect(readDiff(dir, "limit-correct")?.head).toBe("h".repeat(40));
  });

  it("records only the missing packs on a rerun", async () => {
    const first = fakeLab();
    await run(first.lab);
    const second = fakeLab();
    expect(await run(second.lab)).toMatchObject({ recorded: 0, skipped: 9 });
    expect(second.calls).toEqual({ explore: [], record: [], diff: [] });

    rmSync(join(packDir(dir, "limit-broken", "C2"), "pack.json"));
    const third = fakeLab();
    expect(await run(third.lab)).toMatchObject({ recorded: 1, skipped: 8 });
    expect(third.calls.explore).toEqual(["limit-broken/C2"]);
    expect(third.calls.record).toHaveLength(3);
    expect(missingPacks(dir, [{ caseId: "limit-broken", criterionId: "C2" }])).toEqual([]);
  });

  it("keeps a failed exploration as setup_failed, with no takes and its secret redacted", async () => {
    const { lab, calls } = fakeLab({ notFound: ["limit-broken/C1"] });
    await run(lab);

    const pack = readPack(dir, "limit-broken", "C1")!;
    expect(pack.explore.status).toBe("setup_failed");
    expect(pack.explore.reason).toBe("the page asked for [redacted]");
    expect(pack.takes).toBeNull();
    expect(calls.record.filter((r) => r.startsWith("limit-broken/C1/"))).toEqual([]);
    expect(lines.join("\n")).not.toContain(SECRET);
  });

  it("leaves no pack when a take crashes, so the next run tries it again", async () => {
    const { lab } = fakeLab({ crashOn: ["limit-almost-right/C3"] });
    const summary = await run(lab);

    expect(summary.crashed).toEqual(["limit-almost-right C3"]);
    expect(summary.recorded).toBe(8);
    expect(readPack(dir, "limit-almost-right", "C3")).toBeNull();
    expect(lines.join("\n")).toContain("limit-almost-right C3: crashed");
    expect(lines.join("\n")).not.toContain(SECRET);

    const retry = fakeLab();
    expect(await run(retry.lab)).toMatchObject({ recorded: 1, skipped: 8, crashed: [] });
    expect(retry.calls.explore).toEqual(["limit-almost-right/C3"]);
  });

  it("skips a case without a preview, and counts it as not recorded", async () => {
    const { lab, calls } = fakeLab();
    const summary = await recordAll(broken, {
      dir,
      lab,
      originOf: () => null,
      baseOrigin: "https://base.preview.test",
      log: (line) => lines.push(line),
    });
    expect(summary.crashed).toHaveLength(3);
    expect(calls.explore).toEqual([]);
  });
});

describe("the manifest", () => {
  it("lists every pack with its statuses and a hash, and what's missing", async () => {
    const { lab } = fakeLab({ notFound: ["limit-broken/C1"] });
    await run(lab, broken);
    const manifest = manifestOf(dir, limitCases, "b".repeat(40));

    expect(manifest.rows).toHaveLength(3);
    expect(manifest.rows[0]).toMatchObject({
      case: "limit-broken",
      criterion: "C1",
      explore: "setup_failed",
      pr: null,
      base: null,
    });
    expect(manifest.rows[1]).toMatchObject({ pr: ["completed", "completed"], base: "completed" });
    expect(manifest.rows[1]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.missing).toHaveLength(6);
    expect(manifest.exploreUsd).toBeCloseTo(0.018, 10);
    expect(manifest.heads["limit-broken"]).toBe("h".repeat(40));
    expect(JSON.parse(formatManifest(manifest))).toEqual(manifest);
  });

  it("changes a pack's hash when one of its files does", async () => {
    await run(fakeLab().lab, broken);
    const before = manifestOf(dir, limitCases, "b").rows[0]!.sha256;
    writeFileSync(join(packDir(dir, "limit-broken", "C1"), "pr-1", "judge.mp4"), "other");
    expect(manifestOf(dir, limitCases, "b").rows[0]!.sha256).not.toBe(before);
  });
});
