import { describe, expect, it } from "vitest";

import type { LaneResult, SavedPath } from "../schema/index.ts";
import type { ExploreResult } from "./explore.ts";
import { PathCache, recordWithPath, replayBroke } from "./replay.ts";

const path = (name: string): SavedPath => ({
  criterionId: "C2",
  setup: [{ op: "goto", path: "/cart" }],
  trigger: [{ op: "click", target: { by: "role", role: "button", name } }],
  watch: [{ label: "cart", scope: "region", target: { by: "testId", id: "cart" } }],
  portable: true,
});
type Lane = Pick<LaneResult, "status" | "failedStepIndex">;
const ok: Lane = { status: "completed" };
const broken: Lane = { status: "trigger_absent", failedStepIndex: 1 };
const explored = (found: SavedPath | null): ExploreResult => {
  const base = {
    steps: [],
    ms: 1,
    usage: { promptTokens: 0, cachedTokens: 0, completionTokens: 0, reasoningTokens: 0 },
    modelCalls: 1,
  };
  return found
    ? { status: "found", path: found, ...base }
    : { status: "trigger_absent", reason: "no Apply", ...base };
};

/** Records each take as { path, take, lane }; lanes come from `lanes` in order. */
function deps(cached: SavedPath | null, lanes: Lane[], found: SavedPath | null) {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      cached,
      explore: async () => {
        calls.push("explore");
        return explored(found);
      },
      record: async (p: SavedPath, take: number) => {
        calls.push(
          `record ${(p.trigger[0] as { target: { name: string } }).target.name} take ${take}`,
        );
        return { take, lane: lanes.shift()! };
      },
      laneOf: (r: { lane: Lane }) => r.lane,
    },
  };
}

describe("recordWithPath", () => {
  it("replays a cached path that still works, without exploring", async () => {
    const { deps: d, calls } = deps(path("Apply"), [ok], null);
    expect(await recordWithPath(d)).toMatchObject({ kind: "recorded", source: "cache", take: 1 });
    expect(calls).toEqual(["record Apply take 1"]);
  });

  it("explores once when nothing is cached, and records the path it finds", async () => {
    const { deps: d, calls } = deps(null, [ok], path("Apply"));
    const outcome = await recordWithPath(d);
    expect(outcome).toMatchObject({ kind: "recorded", source: "explored", take: 1 });
    expect(outcome.kind === "recorded" && outcome.explored?.status).toBe("found");
    expect(calls).toEqual(["explore", "record Apply take 1"]);
  });

  it("discards a cached path that broke, explores once and records a new take", async () => {
    const { deps: d, calls } = deps(path("Apply"), [broken, ok], path("Redeem"));
    const outcome = await recordWithPath(d);
    expect(outcome).toMatchObject({
      kind: "recorded",
      source: "re_explored",
      take: 2,
      path: path("Redeem"),
    });
    expect(calls).toEqual(["record Apply take 1", "explore", "record Redeem take 2"]);
  });

  it("keeps the broken take when re-exploring finds nothing", async () => {
    const { deps: d } = deps(path("Apply"), [broken], null);
    const outcome = await recordWithPath(d);
    expect(outcome).toMatchObject({
      kind: "not_found",
      explored: { status: "trigger_absent" },
      recording: { take: 1 },
    });
  });

  it("reports what the navigator found when nothing was cached and nothing was found", async () => {
    const { deps: d } = deps(null, [], null);
    const outcome = await recordWithPath(d);
    expect(outcome).toMatchObject({ kind: "not_found", explored: { reason: "no Apply" } });
    expect("recording" in outcome).toBe(false);
  });

  it("doesn't re-explore a replay that completed or failed for another reason", async () => {
    for (const lane of [
      ok,
      { status: "error" as const, failedStepIndex: 0 },
      { status: "setup_failed" as const },
    ]) {
      const { deps: d, calls } = deps(path("Apply"), [lane], path("Redeem"));
      await recordWithPath(d);
      expect(calls).toEqual(["record Apply take 1"]);
    }
  });
});

describe("replayBroke", () => {
  it("is a setup or trigger step that failed", () => {
    expect(replayBroke(broken)).toBe(true);
    expect(replayBroke({ status: "setup_failed", failedStepIndex: 0 })).toBe(true);
    expect(replayBroke(ok)).toBe(false);
    expect(replayBroke({ status: "trigger_absent" })).toBe(false);
    expect(replayBroke({ status: "error", failedStepIndex: 2 })).toBe(false);
  });
});

describe("PathCache", () => {
  it("holds one path per criterion, seeded from the job", () => {
    const cache = new PathCache([path("Apply")]);
    expect(cache.get("C2")).toEqual(path("Apply"));
    cache.put(path("Redeem"));
    expect(cache.get("C2")).toEqual(path("Redeem"));
    cache.discard("C2");
    expect(cache.get("C2")).toBeNull();
  });
});
