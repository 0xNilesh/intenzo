import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { preflight } from "./preflight.ts";

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  server = undefined;
});

/** A preview on a local port: answers each request with the next status (the last one repeats). */
async function preview(statuses: number[], { delayMs = 0, location = "" } = {}) {
  const seen: IncomingMessage[] = [];
  server = createServer((req, res) => {
    seen.push(req);
    const status = statuses[Math.min(seen.length - 1, statuses.length - 1)]!;
    setTimeout(() => {
      res.writeHead(status, location ? { location } : {}).end(`status ${status}`);
    }, delayMs);
  });
  await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  return { origin, seen };
}
const fast = { retryDelaysMs: [1, 1] };

describe("preflight (§19 step 1)", () => {
  it("passes a preview that answers its root page, and sends the bypass", async () => {
    const p = await preview([200]);
    expect(await preflight(`${p.origin}/cart`, { ...fast, bypass: "the-bypass" })).toEqual({
      ok: true,
      status: 200,
    });
    expect(p.seen.map((r) => r.url)).toEqual(["/"]);
    expect(p.seen[0]!.headers["x-vercel-protection-bypass"]).toBe("the-bypass");
  });

  it("passes a redirect without following it", async () => {
    const p = await preview([307], { location: "https://vercel.com/login" });
    expect(await preflight(p.origin, fast)).toEqual({ ok: true, status: 307 });
    expect(p.seen).toHaveLength(1);
  });

  it("asks again after a 5xx, as a cold function can fail once", async () => {
    const p = await preview([500, 200]);
    expect(await preflight(p.origin, fast)).toEqual({ ok: true, status: 200 });
    expect(p.seen).toHaveLength(2);
  });

  it("fails a preview that keeps answering 500, after two more tries", async () => {
    const p = await preview([500]);
    expect(await preflight(p.origin, fast)).toEqual({
      ok: false,
      status: 500,
      problem: "HTTP 500",
    });
    expect(p.seen).toHaveLength(3);
  });

  it("fails a 4xx at once: a missing bypass or deployment doesn't heal", async () => {
    const p = await preview([401]);
    expect(await preflight(p.origin, fast)).toMatchObject({ ok: false, problem: "HTTP 401" });
    expect(p.seen).toHaveLength(1);
  });

  it("fails a preview nothing answers, or that answers too late", async () => {
    const p = await preview([200]);
    const closed = p.origin;
    await new Promise<void>((done) => server!.close(() => done()));
    server = undefined;
    expect(await preflight(closed, fast)).toEqual({ ok: false, problem: "ECONNREFUSED" });

    const slow = await preview([200], { delayMs: 1000 });
    expect(await preflight(slow.origin, { retryDelaysMs: [], timeoutMs: 50 })).toEqual({
      ok: false,
      problem: "timed out after 0.05 s",
    });
  });
});
