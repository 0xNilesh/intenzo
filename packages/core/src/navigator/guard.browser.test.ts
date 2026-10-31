import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildOutline, refLocator } from "../browser/outline.ts";
import { html, startServer, type TestServer } from "../browser/testing.ts";
import { DEFAULT_DENY_TEXT } from "../schema/index.ts";
import { guardAction, type GuardContext } from "./guard.ts";

let browser: Browser;
let app: TestServer;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch();
  app = await startServer("127.0.0.1", (_req, res) =>
    html(
      res,
      `<main><label>Discount code <input></label><button>Apply</button><button>Delete account</button></main>`,
    ),
  );
  page = await browser.newPage();
  await page.goto(app.origin);
});
afterAll(async () => {
  await browser.close();
  await app.close();
});

describe("guardAction on a real page", () => {
  it("passes the field and Apply, and refuses Delete account", async () => {
    const outline = await buildOutline(page);
    const ref = (name: string) =>
      /\[ref=([a-z0-9]+)\]/.exec(outline.text.split("\n").find((l) => l.includes(name))!)![1]!;
    const ctx: GuardContext = {
      origin: app.origin,
      allowedNavigationOrigins: [],
      refs: outline.refs,
      resolve: (r) => refLocator(page, r),
      denyText: [...DEFAULT_DENY_TEXT],
    };
    const act = (
      action: { op: "click"; ref: string } | { op: "fill"; ref: string; value: string },
    ) => guardAction({ thought: "", phase: "setup", action, status: "continue" }, ctx);
    expect(await act({ op: "fill", ref: ref('textbox "Discount code"'), value: "SAVE10" })).toEqual(
      { ok: true },
    );
    expect(await act({ op: "click", ref: ref('button "Apply"') })).toEqual({ ok: true });
    expect(await act({ op: "click", ref: ref('button "Delete account"') })).toMatchObject({
      code: "denied",
    });
    expect(await act({ op: "fill", ref: ref('button "Apply"'), value: "x" })).toMatchObject({
      code: "bad_op",
    });
  });
});
