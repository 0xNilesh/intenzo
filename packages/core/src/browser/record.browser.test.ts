import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { LaneResult, type Criterion, type Reading, type SavedPath } from "../schema/index.ts";
import { now } from "./clock.ts";
import { POST_OFFSETS_MS, recordCriterion, type RecordOptions } from "./record.ts";
import { html, startServer, type TestServer } from "./testing.ts";

// A fixture cart (the same page at / and /cart). Apply shows "Saving..." at once, saves the code
// with a slow same-origin fetch (800 ms), then shows $45.00. The code is kept in a cookie, so a
// reload renders $45.00 straight away. The click also logs a console error, inside the trigger
// window; the one logged on load is outside it.
const cart = (applied: boolean) => `
<main>
  <section aria-label="Cart">
    <p>Total <span data-testid="total">${applied ? "$45.00" : "$50.00"}</span></p>
    <label for="code">Discount code</label><input id="code">
    <button>Apply</button>
  </section>
</main>
<script>
  console.error("analytics blocked");
  document.querySelector("button").addEventListener("click", async () => {
    console.error("tracking blocked");
    const total = document.querySelector("[data-testid=total]");
    total.textContent = "Saving...";
    await fetch("/api/apply", { method: "POST", body: document.getElementById("code").value });
    total.textContent = "$45.00";
  });
</script>`;

const CRITERION: Criterion = {
  id: "C2",
  text: "The total drops to $45.00 right away",
  trigger: "apply SAVE10",
  setup: [],
  expected: "the total shows $45.00 within 1 s",
  watch: ["order total"],
  kind: "ui_behavior",
  persistence: true,
  inferred: false,
};

const PATH: SavedPath = {
  criterionId: "C2",
  setup: [{ op: "goto", path: "/cart" }],
  trigger: [
    { op: "fill", target: { by: "label", text: "Discount code" }, value: "SAVE10" },
    { op: "click", target: { by: "role", role: "button", name: "Apply" } },
  ],
  watch: [
    { label: "order total", scope: "element", target: { by: "testId", id: "total" } },
    { label: "cart", scope: "region", target: { by: "role", role: "region", name: "Cart" } },
  ],
  portable: true,
};

let browser: Browser;
let app: TestServer;
let runRoot: string;
/** Node's clock when each /api/apply request arrived. */
const applyArrivals: number[] = [];

beforeAll(async () => {
  browser = await chromium.launch();
  runRoot = mkdtempSync(join(tmpdir(), "intenzo-record-"));
  app = await startServer("127.0.0.1", (req, res) => {
    if (req.path === "/api/test/session") {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ shopper: "shopper-1" }));
    }
    if (req.path === "/api/apply") {
      applyArrivals.push(now());
      return void setTimeout(() => {
        res.writeHead(200, { "set-cookie": `code=${req.body}; Path=/` });
        res.end("ok");
      }, 800);
    }
    html(res, cart(req.headers.cookie?.includes("code=SAVE10") ?? false));
  });
});

afterAll(async () => {
  await browser.close();
  await app.close();
  rmSync(runRoot, { recursive: true, force: true });
});

let takes = 0;
function record(overrides: Partial<RecordOptions> = {}) {
  takes += 1;
  return recordCriterion(browser, {
    origin: app.origin,
    side: "pr",
    criterion: CRITERION,
    path: PATH,
    outDir: join(runRoot, "C2", "pr", `take-${takes}`),
    ...overrides,
  });
}

const totals = (readings: Reading[], phase: Reading["phase"]) =>
  readings.filter((r) => r.label === "order total" && r.phase === phase);

describe("recordCriterion", () => {
  it("takes Tt when the last trigger action resolves, before any settle", async () => {
    const { lane } = await record();
    expect(lane.status).toBe("completed");
    const tt = lane.tTriggerMs!;
    const click = lane.stepLog.filter((s) => s.trigger).at(-1)!;
    expect(click).toMatchObject({ step: { op: "click" }, trigger: true, ok: true, tMs: tt });
    // The click starts an 800 ms save. Had anything settled before Tt, Tt would come after it.
    expect(tt - applyArrivals.at(-1)!).toBeLessThan(250);
    const [atZero] = totals(lane.readings, "post");
    expect(atZero!.value).toBe("Saving...");
  });

  it("reads POST at Tt+0, +1000 and +3000 (+ timingMs), never early", async () => {
    const { lane } = await record({ criterion: { ...CRITERION, timingMs: 1500 } });
    const tt = lane.tTriggerMs!;
    const offsets = [...POST_OFFSETS_MS, 1500].sort((a, b) => a - b);
    const post = totals(lane.readings, "post");
    expect(post.map((r) => r.value)).toEqual(["Saving...", "$45.00", "$45.00", "$45.00"]);
    post.forEach((reading, n) => {
      expect(reading.tMs).toBeGreaterThanOrEqual(tt + offsets[n]!);
      expect(reading.tMs).toBeLessThan(tt + offsets[n]! + 250);
    });
    // The region and the live regions are read in the same batches.
    expect(lane.readings.filter((r) => r.phase === "post")).toHaveLength(offsets.length * 3);
  });

  it("runs the reload probe for persistence: true", async () => {
    const { lane } = await record();
    expect(lane.stepLog.map((s) => s.step.op)).toEqual(["goto", "fill", "click", "reload"]);
    expect(lane.stepLog.at(-1)!.trigger).toBe(false);
    expect(totals(lane.readings, "after_reload").map((r) => r.value)).toEqual(["$45.00"]);
  });

  it("skips the reload probe for persistence: false", async () => {
    const { lane } = await record({ criterion: { ...CRITERION, persistence: false } });
    expect(lane.stepLog.map((s) => s.step.op)).not.toContain("reload");
    expect(lane.readings.filter((r) => r.phase === "after_reload")).toEqual([]);
  });

  it("writes the take's files and points the lane at them", async () => {
    const outDir = join(runRoot, "C2", "pr", "files");
    const recording = await record({
      outDir,
      identity: { hookPath: "/api/test/session", secret: "s3cret" },
    });
    for (const file of [
      "raw.webm",
      "trace.zip",
      "shot.png",
      "shot-annotated.png",
      "boxes.json",
      "lane.json",
    ]) {
      expect(existsSync(join(outDir, file)), file).toBe(true);
    }
    expect(existsSync(join(outDir, ".video"))).toBe(false);
    expect(recording.rawVideo).toBe(join(outDir, "raw.webm"));
    expect(recording.shotPath).toBe(join(outDir, "shot.png"));
    expect(recording.annotatedShotPath).toBe(join(outDir, "shot-annotated.png"));
    expect(recording.alignment).toMatchObject({ status: "ok", method: "marker" });
    expect(recording.markerShownAt).toBeGreaterThan(recording.lane.laneStartMs);
    expect(recording.boxTrack.some((s) => s.label === "order total" && s.box)).toBe(true);

    const lane = LaneResult.parse(JSON.parse(readFileSync(join(outDir, "lane.json"), "utf8")));
    expect(lane).toEqual(recording.lane);
    expect(lane.isolation).toBe("ephemeral_user");
    // Paths are relative to the run root: {criterion}/{side}/{take}/{file}.
    expect(lane.trace).toMatchObject({ store: "private", path: "C2/pr/files/trace.zip" });
    expect(lane.annotatedShot).toMatchObject({ path: "C2/pr/files/shot-annotated.png" });
    expect(lane.boxTrack).toMatchObject({ path: "C2/pr/files/boxes.json" });
    expect(lane.humanVideo).toBeUndefined();
    expect(lane.videoOffsets).toBeUndefined();
    // One console error on click (in the window); the one on load is outside it.
    expect(lane.consoleErrorCount).toBe(1);
  });

  it("starts at / when the setup doesn't begin with a goto", async () => {
    const { lane } = await record({ path: { ...PATH, setup: [] } });
    expect(lane.status).toBe("completed");
    expect(lane.stepLog[0]).toMatchObject({ step: { op: "goto", path: "/" }, trigger: false });
    expect(lane.isolation).toBe("none");
  });

  it("ends trigger_absent when the trigger control isn't on the page", async () => {
    const redeem = { op: "click", target: { by: "role", role: "button", name: "Redeem" } } as const;
    const recording = await record({ path: { ...PATH, trigger: [redeem] } });
    const { lane } = recording;
    expect(lane.status).toBe("trigger_absent");
    expect(lane.tTriggerMs).toBeNull();
    expect(lane.failedStepIndex).toBe(1);
    expect(lane.stepLog[1]).toMatchObject({ ok: false, trigger: true });
    expect(recording.error).toMatch(/button "Redeem"/);
    // PRE was read; nothing after it.
    expect(new Set(lane.readings.map((r) => r.phase))).toEqual(new Set(["pre"]));
    expect(recording.shotPath).toBeNull();
    expect(recording.alignment.status).toBe("ok");
  });

  it("ends setup_failed when a setup step fails", async () => {
    const open = { op: "click", target: { by: "role", role: "link", name: "Open cart" } } as const;
    const { lane } = await record({ path: { ...PATH, setup: [...PATH.setup, open] } });
    expect(lane.status).toBe("setup_failed");
    expect(lane.failedStepIndex).toBe(1);
    expect(lane.readings).toEqual([]);
  });
});
