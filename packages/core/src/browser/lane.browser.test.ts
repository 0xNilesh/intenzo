import { randomUUID } from "node:crypto";

import { chromium, type Browser } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { signHookCall } from "./hooks.ts";
import { acquireIdentity, HookError, openLane, type Lane } from "./lane.ts";
import { html, pixel, redirect, startServer, type TestServer } from "./testing.ts";

const BYPASS = "bypass-s3cret";
const HOOK_SECRET = "hook-s3cret";

let browser: Browser;
let app: TestServer;
let third: TestServer;
let lane: Lane | undefined;
let production = false;

beforeAll(async () => {
  browser = await chromium.launch();
  third = await startServer("localhost", (req, res) => {
    if (req.path.startsWith("/pixel")) return pixel(res);
    return html(res, "<h1>Third party</h1>");
  });
  app = await startServer("127.0.0.1", (req, res) => {
    const { path, headers } = req;
    if (path === "/") {
      if (
        headers["x-vercel-protection-bypass"] === BYPASS &&
        headers["x-vercel-set-bypass-cookie"]
      ) {
        res.writeHead(200, { "set-cookie": "_vercel_bypass=ok; Path=/; HttpOnly; SameSite=Lax" });
        return res.end("ok");
      }
      return html(res, "<h1>Home</h1>");
    }
    if (path === "/page") {
      return html(
        res,
        `<h1>Cart</h1><img id="direct" src="${third.origin}/pixel.gif"><img id="hop" src="/hop">` +
          `<a id="away" href="${third.origin}/landing">away</a>`,
      );
    }
    if (path === "/hop") return redirect(res, `${third.origin}/pixel.gif?via=redirect`);
    if (path === "/nav-hop") return redirect(res, `${third.origin}/landing`);
    if (path === "/api/test/session") return sessionHook(req, res);
    return html(res, "not found");
  });
});

afterEach(async () => {
  await lane?.close();
  lane = undefined;
  production = false;
  app.requests.length = 0;
  third.requests.length = 0;
});

afterAll(async () => {
  await browser.close();
  await app.close();
  await third.close();
});

// A session hook that follows the §21.1 contract, like demo-shop's.
function sessionHook(
  req: TestServer["requests"][number],
  res: Parameters<Parameters<typeof startServer>[1]>[1],
) {
  if (production) {
    res.writeHead(403);
    return res.end("test hooks are disabled in production");
  }
  const ts = String(req.headers["x-intenzo-timestamp"] ?? "");
  const fresh = Math.abs(Date.now() / 1000 - Number(ts)) < 300;
  if (!fresh || req.headers["x-intenzo-signature"] !== signHookCall(HOOK_SECRET, ts, req.body)) {
    res.writeHead(401);
    return res.end("bad signature");
  }
  const shopper = randomUUID();
  res.writeHead(200, {
    "content-type": "application/json",
    "set-cookie": `shopper=${shopper}; Path=/; HttpOnly`,
  });
  res.end(JSON.stringify({ shopper }));
}

describe("openLane: the bypass secret", () => {
  it("never reaches a third-party origin or a redirect target", async () => {
    lane = await openLane(browser, { origin: app.origin, bypass: BYPASS });
    await lane.page.goto(`${app.origin}/page`, { waitUntil: "load" });
    await expect
      .poll(() => third.requests.filter((r) => r.path.startsWith("/pixel")).length)
      .toBe(2); // the direct image and the one reached through /hop's redirect

    for (const r of third.requests) {
      expect(r.headers["x-vercel-protection-bypass"]).toBeUndefined();
      expect(r.headers.cookie ?? "").not.toContain("_vercel_bypass");
    }
    const withSecret = app.requests.filter((r) => r.headers["x-vercel-protection-bypass"]);
    expect(withSecret.map((r) => r.path)).toEqual(["/"]); // only the one cookie exchange
    const page = app.requests.find((r) => r.path === "/page");
    expect(page?.headers.cookie).toContain("_vercel_bypass=ok"); // the app gets the cookie instead
  });

  it("fails fast when the deployment rejects the bypass", async () => {
    // The mock answers 200 without the secret, so check the rejection path against a 401 origin.
    const locked = await startServer("127.0.0.1", (_req, res) => {
      res.writeHead(401);
      res.end();
    });
    await expect(openLane(browser, { origin: locked.origin, bypass: "wrong" })).rejects.toThrow(
      "the deployment rejected the protection bypass (HTTP 401)",
    );
    await locked.close();
  });
});

describe("openLane: navigation", () => {
  it("aborts off-origin main-frame navigation, while third-party subresources still load", async () => {
    lane = await openLane(browser, { origin: app.origin });
    await lane.page.goto(`${app.origin}/page`, { waitUntil: "load" });
    expect(third.requests.some((r) => r.path === "/pixel.gif")).toBe(true);

    await expect(lane.page.goto(`${third.origin}/landing`)).rejects.toThrow(/ERR_ABORTED/);
    await lane.page.click("#away");
    await lane.page.waitForTimeout(300);

    expect(third.requests.some((r) => r.path === "/landing")).toBe(false);
    expect(lane.page.url()).toBe(`${app.origin}/page`);
    expect(lane.blockedNavigations).toEqual([`${third.origin}/landing`, `${third.origin}/landing`]);
  });

  it("allows a configured extra origin", async () => {
    lane = await openLane(browser, {
      origin: app.origin,
      allowedNavigationOrigins: [third.origin],
    });
    await lane.page.goto(`${third.origin}/landing`);
    expect(lane.page.url()).toBe(`${third.origin}/landing`);
    expect(lane.offOriginNavigations).toEqual([]);
  });

  it("records a redirect that lands the main frame off-origin, so the lane can fail closed", async () => {
    lane = await openLane(browser, { origin: app.origin });
    await lane.page.goto(`${app.origin}/nav-hop`).catch(() => undefined);
    expect(lane.offOriginNavigations).toEqual([`${third.origin}/landing`]);
  });
});

describe("acquireIdentity", () => {
  it("gets a different user on every call, and keeps the session cookie in the lane", async () => {
    lane = await openLane(browser, { origin: app.origin });
    const first = await acquireIdentity(lane, {
      hookPath: "/api/test/session",
      secret: HOOK_SECRET,
    });
    const second = await acquireIdentity(lane, {
      hookPath: "/api/test/session",
      secret: HOOK_SECRET,
    });
    expect(first).not.toBe(second);
    const cookies = await lane.context.cookies(app.origin);
    expect(cookies.find((c) => c.name === "shopper")?.value).toBe(second);
  });

  it("gives separate lanes separate users", async () => {
    const other = await openLane(browser, { origin: app.origin });
    lane = await openLane(browser, { origin: app.origin });
    const a = await acquireIdentity(lane, { hookPath: "/api/test/session", secret: HOOK_SECRET });
    const b = await acquireIdentity(other, { hookPath: "/api/test/session", secret: HOOK_SECRET });
    expect(a).not.toBe(b);
    expect((await other.context.cookies(app.origin)).find((c) => c.name === "shopper")?.value).toBe(
      b,
    );
    await other.close();
  });

  it("surfaces a bad secret as a 401 HookError", async () => {
    lane = await openLane(browser, { origin: app.origin });
    const err = await acquireIdentity(lane, {
      hookPath: "/api/test/session",
      secret: "wrong",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(HookError);
    expect(err).toMatchObject({ status: 401 });
  });

  it("explains a production refusal", async () => {
    production = true;
    lane = await openLane(browser, { origin: app.origin });
    await expect(
      acquireIdentity(lane, { hookPath: "/api/test/session", secret: HOOK_SECRET }),
    ).rejects.toThrow("the session hook refused: test hooks are disabled in production");
  });

  it("refuses a hook path that points at another origin", async () => {
    lane = await openLane(browser, { origin: app.origin });
    await expect(
      acquireIdentity(lane, { hookPath: `${third.origin}/api/test/session`, secret: HOOK_SECRET }),
    ).rejects.toThrow(`session hook must be on ${app.origin}`);
  });
});
