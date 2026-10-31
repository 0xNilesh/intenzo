import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { recordCriterion } from "../browser/record.ts";
import { renderVideos } from "../browser/video.ts";
import { costUsd } from "../models/pricing.ts";
import { Criterion, SavedPath } from "../schema/index.ts";
import type { JudgeSide } from "./bundle.ts";
import { judgeCriterion, judgesFromEnv } from "./judges.ts";

// T4.6, by hand only (`pnpm --filter @intenzo/core exec vitest run --project live judges`): C1–C4
// recorded along the P1 paths on the almost-right preview and on main's, then judged by Spark Open
// and Spark 1.3. Eight judge calls at effort low: about $0.05, a third of it Baseten credit.
// Needs META_API_KEY, BASETEN_API_KEY, DEMO_SHOP_HOOK_SECRET and DEMO_SHOP_BYPASS_SECRET in .env,
// Chromium and ffmpeg. DEMO_PR_URL / DEMO_BASE_URL override the previews below.

const REPO = resolve(import.meta.dirname, "../../../..");
if (existsSync(resolve(REPO, ".env"))) process.loadEnvFile(resolve(REPO, ".env"));
const JUDGES = judgesFromEnv();
const SECRET = process.env.DEMO_SHOP_HOOK_SECRET;
const BYPASS = process.env.DEMO_SHOP_BYPASS_SECRET;
const PR =
  process.env.DEMO_PR_URL ?? "https://demo-shop-j4u50435p-sumithprabhus-projects.vercel.app";
const BASE =
  process.env.DEMO_BASE_URL ?? "https://demo-shop-dly0m1skm-sumithprabhus-projects.vercel.app";
const read = (path: string) => JSON.parse(readFileSync(resolve(REPO, path), "utf8"));

describe.skipIf(!JUDGES || !SECRET || !BYPASS)("the judges on the almost-right PR (live)", () => {
  let browser: Browser;
  let dir: string;
  beforeAll(async () => {
    browser = await chromium.launch();
    dir = mkdtempSync(join(tmpdir(), "intenzo-judges-live-"));
  });
  afterAll(async () => {
    await browser.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function take(criterion: Criterion, side: "pr" | "base"): Promise<JudgeSide> {
    const outDir = join(dir, criterion.id, side);
    const path = SavedPath.parse(read(`fixtures/paths/${criterion.id}.json`));
    const rec = await recordCriterion(browser, {
      origin: side === "pr" ? PR : BASE,
      side,
      criterion,
      path,
      outDir,
      identity: { hookPath: "/api/test/session", secret: SECRET! },
      bypass: BYPASS!,
    });
    if (rec.alignment.status !== "ok" || !rec.rawVideo) return { lane: rec.lane };
    const videos = await renderVideos(
      {
        rawVideo: rec.rawVideo,
        rawOffsetMs: rec.alignment.offsetMs,
        markerShownAt: rec.markerShownAt,
        stepLog: rec.lane.stepLog,
        laneStartMs: rec.lane.laneStartMs,
        outDir,
      },
      { browser },
    );
    return {
      lane: rec.lane,
      judgeVideo: videos.judge.path,
      ...(rec.annotatedShotPath && { annotatedShot: rec.annotatedShotPath }),
    };
  }

  it.each([
    ["C1", "pass"],
    ["C2", "fail"],
    ["C3", "pass"],
    ["C4", "pass"],
  ] as const)(
    "%s → agreed %s",
    async (id, expected) => {
      const criterion = Criterion.parse(read(`fixtures/criteria/${id}.json`));
      const pr = await take(criterion, "pr");
      const base = await take(criterion, "base");
      expect(pr.lane.status).toBe("completed");
      const judged = await judgeCriterion(JUDGES!, criterion, pr, base, "covered");
      for (const [i, out] of judged.outputs.entries()) {
        const call = judged.calls[i]!;
        const cost = costUsd(call.model, call.usage);
        console.log(
          `${id} ${call.judge}: ${out?.verdict ?? `no answer (${call.error})`} [${out?.citedReadings.join(",") ?? ""}] ${JSON.stringify(out?.citedValue ?? null)} · ${call.ms} ms · $${cost?.toFixed(4)} · ${out?.observed ?? ""}`,
        );
      }
      expect(judged.combined).toEqual({ verdict: expected, reason: "agreed" });
      if (id === "C2") {
        // §22.3: the decisive reading is the order total a second after Apply.
        const tt = pr.lane.tTriggerMs!;
        for (const out of judged.outputs) {
          const offsets = out!.citedReadings.map(
            (i) => pr.lane.readings.find((r) => r.i === i)!.tMs - tt,
          );
          expect(
            offsets.some((ms) => ms > 500 && ms < 1500),
            `cites the +1 s reading: ${offsets}`,
          ).toBe(true);
        }
      }
    },
    180_000,
  );
});
