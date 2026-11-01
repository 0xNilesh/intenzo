import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { routeSnapshot } from "./snapshot.ts";

// A cart like demo-shop's, served from memory: the discount form, and the summary with its link.
const CART = `<!doctype html><title>Cart</title>
<header>Signed in as shopper-42a1</header>
<main>
  <h1>Your cart</h1>
  <form aria-label="Discount code"><label>Discount code <input name="code"></label><button type="button">Apply</button></form>
  <section aria-label="Order summary"><p>Total <span data-testid="total">$50.00</span></p><a href="/checkout">Continue</a></section>
</main>`;

describe("routeSnapshot (§24)", () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
    await page.setContent(CART);
  });
  afterAll(() => browser.close());

  it("masks the shopper and marks the lines the trigger's targets touch, nothing else", async () => {
    const snap = await routeSnapshot(page, {
      users: ["shopper-42a1"],
      // As the navigator saved them on demo-shop #22, and one that isn't on this page.
      targets: [
        { by: "role", role: "textbox", name: "Discount code" },
        { by: "role", role: "button", name: "Apply" },
        { by: "role", role: "button", name: "Remove" },
      ],
    });
    const text = snap.lines.map((l) => l.text);
    expect(text.some((t) => t.includes("Signed in as <user>"))).toBe(true);
    expect(text.some((t) => t.includes("shopper-42a1"))).toBe(false);
    const touched = [...snap.touched].sort((a, b) => a - b).map((k) => text[k]);
    expect(touched).toEqual(['- textbox "Discount code"', '- button "Apply"']);
    // The link in the summary stays the diff's to find.
    expect(text).toContain('- link "Continue":');
  });

  it("treats a watched container as a region: nothing inside it is touched", async () => {
    // As the navigator watched C2 on demo-shop #22: the whole Order summary, as an element.
    const snap = await routeSnapshot(page, {
      users: [],
      targets: [{ by: "role", role: "region", name: "Order summary" }],
    });
    expect(snap.touched.size).toBe(0);
  });
});
