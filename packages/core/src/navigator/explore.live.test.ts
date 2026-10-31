import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseConfig } from "../config/load.ts";
import { denyText } from "../config/derive.ts";
import { metaModelPort } from "../models/meta.ts";
import { Criterion } from "../schema/index.ts";
import { explore } from "./explore.ts";

// Live (by hand only: `pnpm --filter @intenzo/core test:live explore`): Wonder explores each of
// the demo ticket's criteria on demo-shop's discount branch, with no hand-written path. It costs
// one Wonder call per step (C1–C4 took 2–4 steps each in T3.4). Needs META_API_KEY and
// DEMO_SHOP_HOOK_SECRET in .env, and the app at DEMO_SHOP_PR_URL (default: the local almost-right
// checkout on :3001).

const REPO = resolve(import.meta.dirname, "../../../..");
if (existsSync(resolve(REPO, ".env"))) process.loadEnvFile(resolve(REPO, ".env"));
const origin = process.env.DEMO_SHOP_PR_URL ?? "http://localhost:3001";
const apiKey = process.env.META_API_KEY;
const hookSecret = process.env.DEMO_SHOP_HOOK_SECRET;

const parsed = parseConfig(
  readFileSync(resolve(REPO, "packages/core/fixtures/config/demo-shop.intenzo.yml"), "utf8"),
);
if (!parsed.ok) throw new Error("the demo-shop config fixture doesn't parse");
const config = parsed.config;
const criterion = (id: string) =>
  Criterion.parse(JSON.parse(readFileSync(resolve(REPO, `fixtures/criteria/${id}.json`), "utf8")));

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(() => browser?.close());

describe.skipIf(!apiKey || !hookSecret)("explore on demo-shop (live, Wonder)", () => {
  it.each(["C1", "C2", "C3", "C4"])("finds %s's trigger and saves a path", async (id) => {
    const result = await explore(browser, {
      origin,
      criterion: criterion(id),
      model: metaModelPort({ apiKey: apiKey! }),
      denyText: denyText(config),
      startPath: config.start.default,
      data: config.data,
      identity: { hookPath: config.isolation.session_hook!, secret: hookSecret! },
      log: (line) => console.log(`${id} ${line}`),
    });
    console.log(
      `${id}: ${result.status} in ${result.steps.length} steps, ${result.ms} ms, ${result.modelCalls} calls, usage ${JSON.stringify(result.usage)}`,
    );
    expect(result.status).toBe("found");
    if (result.status !== "found") return;
    const last = result.path.trigger.at(-1)!;
    expect(last).toMatchObject({ op: "click", target: { name: "Apply" } });
    const code = id === "C3" ? "OLD5" : "SAVE10";
    expect(result.path.trigger.some((s) => s.op === "fill" && s.value === code)).toBe(true);
  });
});
