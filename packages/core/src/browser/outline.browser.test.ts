import { chromium, type Browser, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildOutline, refLocator } from "./outline.ts";
import { html, startServer, type TestServer } from "./testing.ts";

// The contract test for the outline (§20.1): Playwright's AI snapshot is what the navigator reads,
// so a change to its ref format, its iframe handling or ref resolution must fail CI. It's a
// browser test rather than a contract test because it needs Chromium, which CI installs only
// before the browser layer.

const PAGE = `
<header><a href="/">Shop</a><nav aria-label="Main"><a href="/cart">Cart (0)</a></nav></header>
<main>
  <h1>Products</h1>
  <ul aria-label="Products">
    <li>Blue mug <button>Add to cart</button></li>
    <li>Red pen <button>Add to cart</button></li>
  </ul>
  <label>Discount code <input name="code"></label>
  <iframe srcdoc="<button>Pay now</button>" title="Payment"></iframe>
</main>`;

let browser: Browser;
let app: TestServer;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch();
  app = await startServer("127.0.0.1", (_req, res) => html(res, PAGE));
});
afterAll(async () => {
  await browser.close();
  await app.close();
});
beforeEach(async () => {
  page = await browser.newPage();
  await page.goto(`${app.origin}/products`);
  await page.frameLocator("iframe").getByRole("button").waitFor();
});
afterEach(() => page.close());

const refFor = (text: string, line: RegExp) => {
  const found = text.split("\n").find((l) => line.test(l));
  return /\[ref=([a-z0-9]+)\]/.exec(found ?? "")?.[1];
};

describe("buildOutline (AI snapshot contract)", () => {
  it("gives every node an [ref=eN] that resolves to that element", async () => {
    const outline = await buildOutline(page, { collapseLandmarks: false });
    expect(outline.text).toMatch(/\[ref=e\d+\]/);
    expect(outline.path).toBe("/products");
    expect(outline.fallback).toBe(false);
    const ref = refFor(outline.text, /textbox "Discount code"/)!;
    expect(outline.refs.has(ref)).toBe(true);
    await refLocator(page, ref).fill("SAVE10");
    expect(await page.getByLabel("Discount code").inputValue()).toBe("SAVE10");
  });

  it("tells identical buttons apart by ref", async () => {
    const outline = await buildOutline(page);
    const refs = outline.text
      .split("\n")
      .filter((l) => l.includes('button "Add to cart"'))
      .map((l) => /\[ref=([a-z0-9]+)\]/.exec(l)![1]!);
    expect(refs).toHaveLength(2);
    const second = await refLocator(page, refs[1]!).evaluate((b) => b.parentElement!.textContent);
    expect(second).toContain("Red pen");
  });

  it("includes iframe content, with refs that resolve inside the frame", async () => {
    const outline = await buildOutline(page);
    const ref = refFor(outline.text, /button "Pay now"/);
    expect(ref).toMatch(/^f\d+e\d+$/);
    expect(await refLocator(page, ref!).textContent()).toBe("Pay now");
  });

  it("collapses landmarks after the first turn", async () => {
    const first = await buildOutline(page, { collapseLandmarks: false });
    const later = await buildOutline(page);
    expect(refFor(first.text, /link "Cart \(0\)"/)).toBeDefined();
    expect(later.text).toMatch(/banner \[ref=e\d+\] \(collapsed: link "Shop", link "Cart \(0\)"\)/);
  });
});

describe("buildOutline fallback (data-iz-ref)", () => {
  it("tags elements in the page and resolves its refs", async () => {
    const outline = await buildOutline(page, { fallback: true, collapseLandmarks: false });
    expect(outline.fallback).toBe(true);
    const ref = refFor(outline.text, /textbox "Discount code"/)!;
    expect(outline.refs.has(ref)).toBe(true);
    await refLocator(page, ref, { fallback: true }).fill("OLD5");
    expect(await page.getByLabel("Discount code").inputValue()).toBe("OLD5");
    // A second pass re-tags from scratch, so stale refs can't linger.
    await buildOutline(page, { fallback: true });
    expect(await page.locator("[data-iz-ref]").count()).toBeGreaterThan(0);
  });
});
