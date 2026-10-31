import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { locate } from "../browser/readings.ts";
import { html, startServer, type TestServer } from "../browser/testing.ts";
import { durableTarget, isSameElement, regionWatchFor } from "./durable.ts";

// Three identical "Add to cart" buttons; only the third has a test id. A button whose
// accessible name contains "Apply" (so getByRole's substring match finds two), a labelled field,
// a placeholder-only field, and a bare <span> with no role or name.
const PAGE = `
<main>
  <ul aria-label="Products">
    <li>Blue mug <button>Add to cart</button></li>
    <li>Red pen <button>Add to cart</button></li>
    <li>Green cap <button data-testid="add-cap">Add to cart</button></li>
  </ul>
  <form aria-label="Discount code">
    <label>Discount code <input name="code"></label>
    <button>Apply</button>
  </form>
  <button>Apply all coupons</button>
  <input placeholder="Search products">
  <div><span class="x">7 items</span></div>
</main>`;

let browser: Browser;
let app: TestServer;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch();
  app = await startServer("127.0.0.1", (_req, res) => html(res, PAGE));
  page = await browser.newPage();
  await page.goto(app.origin);
});
afterAll(async () => {
  await browser.close();
  await app.close();
});

const addButtons = () => page.getByRole("button", { name: "Add to cart" });

describe("durableTarget", () => {
  it("replays the 2nd identical button to the 2nd button", async () => {
    const second = addButtons().nth(1);
    const target = await durableTarget(page, second);
    expect(target).toEqual({ by: "role", role: "button", name: "Add to cart", nth: 1 });
    expect(await isSameElement(locate(page, target), second)).toBe(true);
    expect(await isSameElement(locate(page, target), addButtons().nth(0))).toBe(false);
  });

  it("prefers a test id when there is one", async () => {
    expect(await durableTarget(page, addButtons().nth(2))).toEqual({ by: "testId", id: "add-cap" });
  });

  it("never saves a role + name that replays to a different element", async () => {
    // getByRole("button", { name: "Apply" }) also matches "Apply all coupons", and replay takes
    // the first match, so the plain role + name can't be saved for either button.
    const apply = page.getByRole("button", { name: "Apply", exact: true });
    const target = await durableTarget(page, apply);
    expect(target).not.toEqual({ by: "role", role: "button", name: "Apply" });
    expect(await isSameElement(locate(page, target), apply)).toBe(true);

    const coupons = page.getByRole("button", { name: "Apply all coupons" });
    const other = await durableTarget(page, coupons);
    expect(await isSameElement(locate(page, other), coupons)).toBe(true);
  });

  it("uses the role + name when it's unique, and labels and placeholders when they're all there is", async () => {
    expect(await durableTarget(page, page.getByRole("textbox", { name: "Discount code" }))).toEqual(
      {
        by: "role",
        role: "textbox",
        name: "Discount code",
      },
    );
    const search = page.locator("input[placeholder]");
    const target = await durableTarget(page, search);
    expect(await isSameElement(locate(page, target), search)).toBe(true);
  });

  it("falls back to the shortest unique CSS path for an element with no role or name", async () => {
    const span = page.locator("span.x");
    const target = await durableTarget(page, span);
    expect(target.by).toBe("css");
    expect(await isSameElement(locate(page, target), span)).toBe(true);
  });

  it("leaves the outline's refs working: it never takes a snapshot of its own", async () => {
    const outline = await page.ariaSnapshot({ mode: "ai" });
    const refOf = (line: RegExp) =>
      /\[ref=([a-z0-9]+)\]/.exec(outline.split("\n").find((l) => line.test(l))!)![1]!;
    const field = refOf(/textbox "Discount code"/);
    const apply = refOf(/button "Apply" \[/);
    expect(await durableTarget(page, page.getByRef(field))).toEqual({
      by: "role",
      role: "textbox",
      name: "Discount code",
    });
    await regionWatchFor(page, page.getByRef(field));
    expect(await page.getByRef(apply).count()).toBe(1);
  });

  it("uses the caller's exact role and name when given", async () => {
    const second = addButtons().nth(1);
    expect(await durableTarget(page, second, { role: "button", name: "Add to cart" })).toEqual({
      by: "role",
      role: "button",
      name: "Add to cart",
      nth: 1,
    });
  });

  it("refuses an element that isn't exactly one", async () => {
    await expect(durableTarget(page, addButtons())).rejects.toThrow(/exactly one/);
  });
});

describe("regionWatchFor", () => {
  it("finds the enclosing form, named by its accessible name", async () => {
    const region = await regionWatchFor(
      page,
      page.getByRole("button", { name: "Apply", exact: true }),
    );
    expect(region).toEqual({
      label: "Discount code",
      scope: "region",
      target: { by: "role", role: "form", name: "Discount code" },
    });
  });

  it("finds a named list's enclosing landmark, else main", async () => {
    const region = await regionWatchFor(page, page.locator("span.x"));
    expect(region.scope).toBe("region");
    expect(await isSameElement(locate(page, region.target), page.locator("main"))).toBe(true);
  });
});
