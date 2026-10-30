import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Reading, WatchTarget } from "../schema/index.ts";
import { BoxPoller } from "./boxes.ts";
import { now } from "./clock.ts";
import { LIVE_REGIONS, Reader } from "./readings.ts";
import { html, startServer, type TestServer } from "./testing.ts";

// The cart fixture: "Apply code" changes the total, removes the promo banner, updates a status
// line inside <main>, mounts a toast in a body-level portal (as toast libraries do) and fills a
// Next.js-style route announcer, which must not count as feedback.
const CART = `
<main>
  <section aria-label="Cart">
    <h1>Cart</h1>
    <p data-testid="total">$50.00</p>
    <p data-testid="promo">Use SAVE10 for 10% off</p>
    <button>Apply code</button>
    <div role="status" id="status"></div>
  </section>
  <a href="/other">Other page</a>
</main>
<next-route-announcer><div id="__next-route-announcer__" role="alert" aria-live="assertive"></div></next-route-announcer>
<script>
  document.querySelector("button").addEventListener("click", () => {
    document.querySelector("[data-testid=total]").textContent = "$45.00";
    document.querySelector("[data-testid=promo]").remove();
    document.getElementById("status").textContent = "1 code applied";
    const portal = document.createElement("div");
    portal.style.cssText = "position:fixed;bottom:16px;right:16px";
    portal.innerHTML = '<div role="alert">Code SAVE10 applied</div>';
    document.body.append(portal);
    document.getElementById("__next-route-announcer__").textContent = "Cart | Demo shop";
  });
</script>`;

const OTHER = `<main><div style="height:300px"></div><p data-testid="total">$12.00</p></main>`;

const WATCH: WatchTarget[] = [
  { label: "order total", scope: "element", target: { by: "testId", id: "total" } },
  { label: "promo banner", scope: "element", target: { by: "testId", id: "promo" } },
  { label: "cart", scope: "region", target: { by: "role", role: "region", name: "Cart" } },
];

let browser: Browser;
let app: TestServer;
let context: BrowserContext;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch();
  app = await startServer("127.0.0.1", (req, res) =>
    html(res, req.path === "/other" ? OTHER : CART),
  );
});

afterAll(async () => {
  await browser.close();
  await app.close();
});

beforeEach(async () => {
  context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  page = await context.newPage();
});

afterEach(() => context.close());

async function applyCode(reader: Reader) {
  await page.goto(`${app.origin}/cart`);
  const pre = await reader.read("pre");
  await page.getByRole("button", { name: "Apply code" }).click();
  await page.getByText("Code SAVE10 applied").waitFor();
  return { pre, post: await reader.read("post") };
}

const byLabel = (readings: Reading[], label: string) => readings.find((r) => r.label === label)!;

describe("Reader", () => {
  it("shows a toast mounted in a body-level portal as a live-region diff", async () => {
    const { pre, post } = await applyCode(new Reader(page, WATCH));
    expect(byLabel(pre, LIVE_REGIONS)).toMatchObject({ kind: "text", phase: "pre" });
    const live = byLabel(post, LIVE_REGIONS);
    expect(live).toMatchObject({ kind: "region_diff", phase: "post" });
    expect(live.value!.split("\n")).toEqual(
      expect.arrayContaining(["+ alert: Code SAVE10 applied", "+ status: 1 code applied"]),
    );
    // The Next.js route announcer's title announcement is not app feedback.
    expect(live.value).not.toContain("Demo shop");
  });

  it("reads a removed element as absent", async () => {
    const { pre, post } = await applyCode(new Reader(page, WATCH));
    expect(byLabel(pre, "promo banner")).toMatchObject({
      kind: "text",
      value: "Use SAVE10 for 10% off",
    });
    expect(byLabel(post, "promo banner")).toMatchObject({
      kind: "absent",
      value: null,
      bbox: null,
    });
  });

  it("reads elements as innerText + bbox and regions as a diff against PRE", async () => {
    const reader = new Reader(page, WATCH);
    const before = now();
    const { pre, post } = await applyCode(reader);
    const total = byLabel(post, "order total");
    expect(byLabel(pre, "order total")).toMatchObject({ kind: "text", value: "$50.00" });
    expect(total).toMatchObject({ kind: "text", value: "$45.00" });
    expect(total.bbox).toEqual([
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
    ]);
    expect(total.tMs).toBeGreaterThanOrEqual(before);
    expect(total.tMs).toBeLessThanOrEqual(now());

    const cart = byLabel(post, "cart");
    expect(cart.kind).toBe("region_diff");
    expect(cart.value!.split("\n")).toEqual(
      expect.arrayContaining([
        "+ paragraph: $45.00",
        "- paragraph: $50.00",
        "- paragraph: Use SAVE10 for 10% off",
      ]),
    );
    // Indices run on across phases, so the judges can cite any reading.
    expect(reader.readings.map((r) => r.i)).toEqual(reader.readings.map((_, i) => i));
  });

  it("diffs a region that was missing at PRE against nothing", async () => {
    await page.goto(`${app.origin}/other`);
    const reader = new Reader(page, WATCH);
    expect(byLabel(await reader.read("pre"), "cart").kind).toBe("absent");
    await page.goto(`${app.origin}/cart`);
    const cart = byLabel(await reader.read("after_reload"), "cart");
    expect(cart.kind).toBe("region_diff");
    expect(cart.value).toContain("+ paragraph: $50.00");
  });
});

describe("BoxPoller", () => {
  it("keeps tracking boxes across a navigation, stamped with the canonical clock", async () => {
    const poller = await BoxPoller.install(context, [
      ...WATCH,
      {
        label: "apply button",
        scope: "element",
        target: { by: "role", role: "button", name: "apply" },
      },
    ]);
    const start = now();
    await page.goto(`${app.origin}/cart`);
    await page.waitForTimeout(200);
    await poller.drain(page);
    await page.getByRole("link", { name: "Other page" }).click();
    await page.waitForURL("**/other");
    await page.waitForTimeout(200);
    await poller.drain(page);

    // The first frame can run before the element is parsed, so look at the shown boxes.
    const totals = poller.track.filter((s) => s.label === "order total" && s.box !== null);
    const [onCart, onOther] = [totals[0]!, totals.at(-1)!];
    expect(onOther.box![1]).toBeGreaterThan(onCart.box![1] + 100); // moved down on /other
    expect(onOther.tMs).toBeGreaterThan(onCart.tMs);
    for (const s of poller.track) {
      expect(s.tMs).toBeGreaterThanOrEqual(start);
      expect(s.tMs).toBeLessThanOrEqual(now());
    }
    // role + name resolves in the page too; the button isn't on /other, so its box goes null.
    const button = poller.track.filter((s) => s.label === "apply button");
    expect(button.some((s) => s.box !== null)).toBe(true);
    expect(button.at(-1)!.box).toBeNull();
  });

  it("logs only changes, so a still page adds no samples", async () => {
    const poller = await BoxPoller.install(context, WATCH);
    await page.goto(`${app.origin}/cart`);
    await page.waitForTimeout(200);
    await poller.drain(page);
    await page.waitForTimeout(500); // about 30 frames
    expect(await poller.drain(page)).toEqual([]);
    expect(poller.track.some((s) => s.label === "cart")).toBe(false); // regions aren't polled
  });
});
