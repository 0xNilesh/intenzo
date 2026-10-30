import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CLIPS } from "../clips.ts";
import { startShop, type ShopServer } from "../fixture/server.ts";
import { LIVE_REGIONS, recordClip } from "./record.ts";
import type { Lane, Reading } from "./schema.ts";

// Real time on purpose: the recorder's POST readings are scheduled against the wall clock.
let browser: Browser;
let shop: ShopServer;

beforeAll(async () => {
  shop = await startShop();
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await shop?.close();
});

const clip = (id: string) => CLIPS.find((c) => c.id === id)!;
const values = (lane: Lane, label: string, phase: Reading["phase"]) =>
  lane.readings.filter((r) => r.label === label && r.phase === phase).map((r) => r.value);

describe("recordClip", () => {
  it("reads the stale total at +0, +1 and +3 s, then the fixed total after a reload", async () => {
    const lane = await recordClip(browser, shop.origin, clip("total-stale"));

    expect(lane.stepLog.map((s) => s.step.op)).toEqual(["goto", "fill", "click", "reload"]);
    expect(lane.stepLog[0]!.step).toEqual({ op: "goto", path: "/cart" }); // no variant name
    expect(lane.stepLog.filter((s) => s.trigger)).toHaveLength(1);
    expect(lane.tTriggerMs).toBe(lane.stepLog[2]!.tMs);

    expect(values(lane, "order total", "pre")).toEqual(["$50.00"]);
    expect(values(lane, "order total", "post")).toEqual(["$50.00", "$50.00", "$50.00"]);
    expect(values(lane, "order total", "after_reload")).toEqual(["$45.00"]);
    const post = lane.readings.filter((r) => r.label === "order total" && r.phase === "post");
    expect(post.map((r) => r.tMs - lane.tTriggerMs >= 0)).toEqual([true, true, true]);
    expect(post[1]!.tMs - lane.tTriggerMs).toBeGreaterThanOrEqual(1000);
    expect(post[2]!.tMs - lane.tTriggerMs).toBeGreaterThanOrEqual(3000);
    expect(post[1]!.bbox).toHaveLength(4);

    expect(values(lane, LIVE_REGIONS, "post")[0]).toBe("+ status: Discount SAVE10 applied");
    expect(lane.readings.map((r) => r.i)).toEqual(lane.readings.map((_, n) => n));
    expect([lane.consoleErrorCount, lane.failedRequestCount]).toEqual([0, 0]);
  });

  it("reads an error toast as text and as a live-region line", async () => {
    const lane = await recordClip(browser, shop.origin, clip("expired-correct"));
    expect(lane.readings.find((r) => r.label === "error message")).toMatchObject({
      phase: "pre",
      kind: "absent",
      value: null,
    });
    expect(values(lane, "error message", "post")[0]).toBe("This code has expired");
    expect(values(lane, LIVE_REGIONS, "post")[0]).toBe("+ alert: This code has expired");
  });

  it("reads a missing error as absent with no live-region change", async () => {
    const lane = await recordClip(browser, shop.origin, clip("expired-missing"));
    expect(values(lane, "error message", "post")).toEqual([null, null, null]);
    expect(values(lane, LIVE_REGIONS, "post")).toEqual(["no change", "no change", "no change"]);
  });
});
