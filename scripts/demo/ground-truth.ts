// Proves what each demo branch of demo-shop does (ROADMAP T0.6): the labels the go/no-go, the
// golden comment and the P1 gate are scored against.
//   pnpm demo:ground-truth correct|almost-right [--url=https://…]
// The default URL is the branch's Vercel alias. Every check starts from a fresh shopper made
// by the signed session hook, the way Intenzo records, and reads at Tt+0, +1 s and +3 s (§21.3).
// Needs DEMO_SHOP_HOOK_SECRET and, for a protected preview, DEMO_SHOP_BYPASS_SECRET in .env.
// Exits 1 unless every observation equals the branch's ground truth.
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { chromium, type Browser, type Page } from "playwright";

import { loadDotEnv } from "../probe/lib/env.ts";
import {
  aliasUrl,
  BRANCHES,
  DISCOUNT_SLICE_DEG,
  expectationsFor,
  OFFSETS_MS,
  type BranchKey,
} from "./lib/ground-truth.ts";
import { hookHeaders } from "./lib/hooks.ts";

const key = process.argv[2] as BranchKey;
if (!(key in BRANCHES)) {
  console.error(`Usage: pnpm demo:ground-truth ${Object.keys(BRANCHES).join("|")} [--url=…]`);
  process.exit(2);
}
const origin =
  process.argv.find((a) => a.startsWith("--url="))?.slice(6) ?? aliasUrl(BRANCHES[key].branch);
loadDotEnv();
const hookSecret = process.env.DEMO_SHOP_HOOK_SECRET;
const bypass = process.env.DEMO_SHOP_BYPASS_SECRET;
if (!hookSecret) {
  console.error("DEMO_SHOP_HOOK_SECRET is not set (see .env.example)");
  process.exit(2);
}

/** A cart page for a brand-new shopper: the $50.00 seed cart. */
async function freshCart(browser: Browser): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    // Vercel's documented bypass for automation; demo-shop loads nothing third-party.
    ...(bypass && {
      extraHTTPHeaders: {
        "x-vercel-protection-bypass": bypass,
        "x-vercel-set-bypass-cookie": "true",
      },
    }),
  });
  const body = JSON.stringify({ nonce: randomUUID() });
  const session = await context.request.post(`${origin}/api/test/session`, {
    headers: hookHeaders(hookSecret!, body),
    data: body,
  });
  if (session.status() !== 200) throw new Error(`session hook answered HTTP ${session.status()}`);
  const page = await context.newPage();
  await page.goto(`${origin}/cart`);
  await page.getByTestId("total").waitFor();
  return page;
}

/** Applies a code and returns Tt: the moment the click resolves. */
async function apply(page: Page, code: string): Promise<number> {
  await page.getByRole("textbox", { name: "Discount code" }).fill(code);
  await page.getByRole("button", { name: "Apply" }).click();
  return Date.now();
}

const until = (epochMs: number) => sleep(Math.max(0, epochMs - Date.now()));
const text = async (page: Page, testId: string) => {
  const el = page.getByTestId(testId);
  return (await el.count()) === 0 ? "(absent)" : (await el.innerText()).replace(/\s+/g, " ").trim();
};

/** The chart's color at an angle (degrees clockwise from 12 o'clock), as demo-shop draws it. */
function chartColor(page: Page, degrees: number): Promise<string> {
  const r = (110 + 62) / 2; // midway between demo-shop's CHART.outer and CHART.inner
  const a = (degrees * Math.PI) / 180;
  const point = [Math.round(120 + r * Math.sin(a)), Math.round(120 - r * Math.cos(a))];
  return page.getByTestId("savings-chart").evaluate((canvas, [x, y]) => {
    // The scripts package has no DOM types; this is the slice of the canvas API used here.
    type Canvas = {
      getContext(kind: "2d"): { getImageData(...box: number[]): { data: Uint8ClampedArray } };
    };
    const [red, green, blue] = (canvas as unknown as Canvas)
      .getContext("2d")
      .getImageData(x!, y!, 1, 1).data;
    return `#${[red, green, blue].map((v) => v!.toString(16).padStart(2, "0")).join("")}`;
  }, point);
}

const browser = await chromium.launch();
const observed: string[] = [];
try {
  // C1: the discount line, right after Apply.
  {
    const page = await freshCart(browser);
    await apply(page, "SAVE10");
    observed.push(await text(page, "discount-line"));
  }
  // C2: the total at Tt+0/+1s/+3s, then after a reload (the code is saved by then).
  {
    const page = await freshCart(browser);
    const tt = await apply(page, "SAVE10");
    const totals: string[] = [];
    for (const offset of OFFSETS_MS) {
      await until(tt + offset);
      totals.push(await text(page, "total"));
    }
    await page.reload();
    await page.getByTestId("total").waitFor();
    observed.push(`${totals.join(", ")}; reload ${await text(page, "total")}`);
  }
  // C3: the expired-code toast, within a second. Next.js also keeps an empty role=alert route
  // announcer on every page, so the toast is found by its text.
  {
    const page = await freshCart(browser);
    await apply(page, "OLD5");
    const toast = page.getByRole("alert").filter({ hasText: "This code has expired" });
    const shown = await toast.waitFor({ timeout: 1000 }).then(
      () => true,
      () => false,
    );
    observed.push(shown ? await toast.innerText() : "(no toast)");
  }
  // C4: the chart's discount slice, before Apply and at Tt+1s.
  {
    const page = await freshCart(browser);
    const before = await chartColor(page, DISCOUNT_SLICE_DEG);
    const tt = await apply(page, "SAVE10");
    await until(tt + 1000);
    observed.push(`${before} → ${await chartColor(page, DISCOUNT_SLICE_DEG)}`);
  }
  // The unrequested change §24 looks for: the label of the cart's button to /checkout.
  {
    const page = await freshCart(browser);
    observed.push((await page.locator('a[href="/checkout"]').innerText()).trim());
  }
} finally {
  await browser.close();
}

const rows = expectationsFor(key).map((e, n) => ({
  ...e,
  observed: observed[n]!,
  ok: observed[n] === e.expected,
}));
console.log(`\nGround truth for ${BRANCHES[key].branch} at ${origin}\n`);
for (const r of rows) {
  console.log(`${r.ok ? "✓" : "✗"} ${r.criterion.padEnd(7)} ${r.check.padEnd(38)} ${r.observed}`);
  if (!r.ok) console.log(`  ${"".padEnd(7)} ${"expected".padEnd(38)} ${r.expected}`);
}
const ok = rows.every((r) => r.ok);
console.log(
  `\n${ok ? "PROVEN" : "NOT PROVEN"}: ${BRANCHES[key].labels}${ok ? "" : " (observations differ, above)"}`,
);
process.exit(ok ? 0 : 1);
