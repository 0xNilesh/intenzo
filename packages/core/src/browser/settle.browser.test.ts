import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { showSyncMarker } from "./clock.ts";
import { QUIET_MS, SETTLE_CAP_MS, Settler } from "./settle.ts";
import { html, pixel, startServer, type TestServer } from "./testing.ts";

// Fixture pages for settle() (§20.3.1). The app is on 127.0.0.1, the "third party" on localhost.
const QUIET = `<p>Nothing happens here.</p>`;
// Polls the app every 500 ms and writes the answer into the page, like a live order status.
const POLLING = `<p id="status">waiting</p><script>
  let n = 0;
  setInterval(async () => {
    const res = await fetch("/api/status");
    document.getElementById("status").textContent = (await res.text()) + " " + ++n;
  }, 500);
</script>`;
// Rewrites itself every 100 ms: never quiet for 300 ms.
const BUSY = `<p id="tick">0</p><script>
  let n = 0;
  setInterval(() => (document.getElementById("tick").textContent = String(++n)), 100);
</script>`;
// One slow same-origin fetch (800 ms) that changes nothing on the page until it lands.
const SAVING = `<button onclick="save()">Save</button><script>
  function save() { fetch("/api/slow"); }
</script>`;

let browser: Browser;
let app: TestServer;
let third: TestServer;
let context: BrowserContext;
let page: Page;
let settler: Settler;

beforeAll(async () => {
  browser = await chromium.launch();
  third = await startServer("localhost", (req, res) => {
    // Never answers: a third-party request still pending must not hold settle() up.
    if (req.path === "/hang") return;
    pixel(res);
  });
  app = await startServer("127.0.0.1", (req, res) => {
    if (req.path === "/api/status") return void res.end("ok");
    if (req.path === "/api/slow") return void setTimeout(() => res.end("saved"), 800);
    if (req.path === "/polling") return html(res, POLLING);
    if (req.path === "/busy") return html(res, BUSY);
    if (req.path === "/saving") return html(res, SAVING);
    if (req.path === "/third-party") {
      return html(res, `${QUIET}<script>fetch("${third.origin}/hang").catch(() => {})</script>`);
    }
    html(res, QUIET);
  });
});

afterAll(async () => {
  await browser.close();
  await app.close();
  await third.close();
});

beforeEach(async () => {
  context = await browser.newContext();
  settler = await Settler.install(context, app.origin);
  page = await context.newPage();
});

afterEach(() => context.close());

describe("settle", () => {
  it("returns about 300 ms after a quiet page loads", async () => {
    await page.goto(`${app.origin}/`);
    const result = await settler.settle(page);
    expect(result.settled).toBe(true);
    expect(result.ms).toBeGreaterThanOrEqual(QUIET_MS - 5);
    expect(result.ms).toBeLessThan(QUIET_MS + 250);
  });

  it("returns within 2 s on a page that polls every 500 ms", async () => {
    await page.goto(`${app.origin}/polling`);
    const result = await settler.settle(page);
    expect(result.ms).toBeLessThanOrEqual(SETTLE_CAP_MS + 100);
  });

  it("gives up at the 2 s cap on a page that never stops changing", async () => {
    await page.goto(`${app.origin}/busy`);
    const result = await settler.settle(page);
    expect(result.settled).toBe(false);
    expect(result.ms).toBeGreaterThanOrEqual(SETTLE_CAP_MS);
    expect(result.ms).toBeLessThan(SETTLE_CAP_MS + 250);
  });

  it("waits for a pending same-origin fetch", async () => {
    await page.goto(`${app.origin}/saving`);
    await settler.settle(page);
    await page.getByRole("button", { name: "Save" }).click();
    const result = await settler.settle(page);
    expect(result.settled).toBe(true);
    // The fetch takes 800 ms; the page itself never changes.
    expect(result.ms).toBeGreaterThanOrEqual(700);
    expect(settler.pending).toBe(0);
  });

  it("ignores a third-party request that never finishes", async () => {
    await page.goto(`${app.origin}/third-party`);
    const result = await settler.settle(page);
    expect(result.settled).toBe(true);
    expect(result.ms).toBeLessThan(QUIET_MS + 250);
  });

  it("ignores Intenzo's own DOM writes: the sync marker and element ids", async () => {
    await page.goto(`${app.origin}/`);
    await settler.settle(page);
    const marker = showSyncMarker(page);
    await page.locator("[data-intenzo-marker]").waitFor({ state: "attached" });
    // Mid-settle: the marker comes off after 300 ms, and the navigator tags an element at 150 ms.
    await page.evaluate(() =>
      setTimeout(() => document.querySelector("p")!.setAttribute("data-iz-ref", "e1"), 150),
    );
    const result = await settler.settle(page);
    await marker;
    expect(result.settled).toBe(true);
    expect(result.ms).toBeLessThan(QUIET_MS + 150);
  });
});
