import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cartUrl, startShop, type ShopServer, type Variant } from "./server.ts";

// The ground truth behind every go/no-go clip: each variant of the fixture shop does exactly what
// its label says. Page timers run on Playwright's fake clock, so "after 3 s" takes no real time.
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

async function openCart(variant: Variant): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.clock.install();
  await page.goto(cartUrl(shop.origin, variant));
  return page;
}

async function apply(page: Page, code: string): Promise<void> {
  await page.getByTestId("discount-input").fill(code);
  await page.getByTestId("apply").click();
}

const text = (page: Page, testId: string): Promise<string> => page.getByTestId(testId).innerText();
const toasts = (page: Page): Promise<string> => page.locator("#toasts").innerText();

describe("fixture shop variants", () => {
  it("correct: SAVE10 takes 10% off at once and survives a reload", async () => {
    const page = await openCart("correct");
    expect(await text(page, "total")).toBe("$50.00");
    expect(await page.getByTestId("discount-line").isVisible()).toBe(false);
    await apply(page, "SAVE10");
    expect(await text(page, "discount-amount")).toBe("−$5.00");
    expect(await text(page, "total")).toBe("$45.00");
    expect(await toasts(page)).toBe("Discount SAVE10 applied");
    await page.reload();
    expect(await text(page, "discount-amount")).toBe("−$5.00");
    expect(await text(page, "total")).toBe("$45.00");
  });

  it("correct: OLD5 shows the error 'This code has expired'", async () => {
    const page = await openCart("correct");
    await apply(page, "OLD5");
    expect(await page.getByRole("alert").innerText()).toBe("This code has expired");
    expect(await text(page, "total")).toBe("$50.00");
  });

  it("stale-total: the line updates but the total stays $50.00 until a reload", async () => {
    const page = await openCart("stale-total");
    await apply(page, "SAVE10");
    expect(await text(page, "discount-amount")).toBe("−$5.00");
    await page.clock.runFor(3000);
    expect(await text(page, "total")).toBe("$50.00");
    await page.reload();
    expect(await text(page, "total")).toBe("$45.00");
  });

  it("off-by-cent: SAVE10 takes $4.99 off, so the total is $45.01", async () => {
    const page = await openCart("off-by-cent");
    await apply(page, "SAVE10");
    expect(await text(page, "discount-amount")).toBe("−$4.99");
    expect(await text(page, "total")).toBe("$45.01");
  });

  it("wrong-percent: SAVE10 takes 15% off", async () => {
    const page = await openCart("wrong-percent");
    await apply(page, "SAVE10");
    expect(await text(page, "discount-amount")).toBe("−$7.50");
    expect(await text(page, "total")).toBe("$42.50");
  });

  it("missing-error: OLD5 shows nothing at all", async () => {
    const page = await openCart("missing-error");
    await apply(page, "OLD5");
    await page.clock.runFor(3000);
    expect(await page.getByRole("alert").count()).toBe(0);
    expect(await toasts(page)).toBe("");
    expect(await text(page, "total")).toBe("$50.00");
  });

  it("quiet-confirm: SAVE10 works; the only confirmation is a grey 'Applied' button", async () => {
    const page = await openCart("quiet-confirm");
    await apply(page, "SAVE10");
    expect(await text(page, "total")).toBe("$45.00");
    expect(await toasts(page)).toBe("");
    expect(await text(page, "apply")).toBe("Applied");
    expect(await page.getByTestId("apply").isDisabled()).toBe(true);
  });

  it("slow-total: the total reads 'Updating…' for 2 s, then $45.00", async () => {
    const page = await openCart("slow-total");
    await apply(page, "SAVE10");
    expect(await text(page, "discount-amount")).toBe("−$5.00");
    expect(await text(page, "total")).toBe("Updating…");
    await page.clock.runFor(1900);
    expect(await text(page, "total")).toBe("Updating…");
    await page.clock.runFor(200);
    expect(await text(page, "total")).toBe("$45.00");
  });
});
