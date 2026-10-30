import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyHtml, cartHtml, TRUTH } from "./media.ts";

// The probes score SAM's boxes and the computer-use click against these pixels, so the rendered
// red box and Apply button must sit exactly at TRUTH's coordinates, edges included.
let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
});

async function render(html: string, width: number, height: number): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.setContent(html);
  return page;
}

/** The background color of whatever is drawn at (x, y). */
const colorAt = (page: Page, x: number, y: number) =>
  page.evaluate(
    ([px, py]) => {
      // Runs in the page; typed structurally because the scripts package has no DOM types.
      const g = globalThis as unknown as {
        document: { elementFromPoint(x: number, y: number): unknown };
        getComputedStyle(el: unknown): { backgroundColor: string };
      };
      return g.getComputedStyle(g.document.elementFromPoint(px!, py!)).backgroundColor;
    },
    [x, y],
  );

describe("probe media", () => {
  it("puts the cart's red box exactly at TRUTH.redBox, for either total", async () => {
    const { x1, y1, x2, y2 } = TRUTH.redBox;
    for (const total of ["$50.00", "$45.00"]) {
      const page = await render(cartHtml(total), TRUTH.video.width, TRUTH.video.height);
      for (const [x, y] of [
        [x1, y1],
        [x2, y2],
        [(x1 + x2) / 2, (y1 + y2) / 2],
      ]) {
        expect(await colorAt(page, x!, y!)).toBe("rgb(255, 0, 0)");
      }
      for (const [x, y] of [
        [x1 - 1, y1],
        [x2 + 1, y2],
        [x1, y1 - 1],
        [x2, y2 + 1],
      ]) {
        expect(await colorAt(page, x!, y!)).not.toBe("rgb(255, 0, 0)");
      }
      expect(await page.getByText(total, { exact: true }).isVisible()).toBe(true);
      await page.close();
    }
  });

  it("puts the Apply button exactly at TRUTH.applyButton", async () => {
    const { x1, y1, x2, y2 } = TRUTH.applyButton;
    const page = await render(applyHtml(), 1280, 720);
    for (const [x, y] of [
      [x1, y1],
      [x2, y2],
    ]) {
      expect(await colorAt(page, x!, y!)).toBe("rgb(37, 99, 235)");
    }
    expect(await colorAt(page, x2 + 1, y2)).not.toBe("rgb(37, 99, 235)");
    expect(await page.getByText("Apply", { exact: true }).isVisible()).toBe(true);
    await page.close();
  });
});
