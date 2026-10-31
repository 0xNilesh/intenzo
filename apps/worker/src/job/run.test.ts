import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { jobClient } from "./client.ts";
import { EXIT, runJob } from "./run.ts";

const JOB = "6f1d2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b";
const RUN = "ea44d35d-4baa-4f81-ac92-08285fae4058";

interface Received {
  method: string;
  path: string;
  auth: string | undefined;
  body: Record<string, unknown> | null;
}

let server: Server | undefined;
afterEach(() => new Promise<void>((done) => (server ? server.close(() => done()) : done())));

/**
 * A stand-in for the Cloud's worker routes on a local port: records each request and answers with
 * the status `answer` picks (202 for events and 200 for alive by default).
 */
async function fakeCloud(
  answer: (request: Received, index: number) => number | undefined = () => undefined,
) {
  const received: Received[] = [];
  server = createServer(async (req: IncomingMessage, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const request: Received = {
      method: req.method!,
      path: req.url!,
      auth: req.headers.authorization,
      body: raw ? (JSON.parse(raw) as Record<string, unknown>) : null,
    };
    received.push(request);
    const status = answer(request, received.length - 1) ?? (req.method === "POST" ? 202 : 200);
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ status }));
  });
  await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
  const { port } = server!.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, received };
}

const sleepJob = (baseUrl: string, seconds = 0.05) => ({
  type: "sleep",
  jobId: JOB,
  runId: RUN,
  deadlineAt: "2026-10-31T09:15:00.000Z",
  callback: { baseUrl, token: "job-token" },
  seconds,
  aliveEverySeconds: 0.01,
});
const quick = {
  client: (job: Parameters<typeof jobClient>[0]) => jobClient(job, { retryDelayMs: 1 }),
};
const events = (received: Received[]) =>
  received.filter((r) => r.method === "POST").map((r) => `${r.body?.kind}#${r.body?.seq}`);

describe("runJob (§9)", () => {
  it("reports started then finished, numbering from 0, and asks /alive while it sleeps", async () => {
    const cloud = await fakeCloud();
    expect(await runJob(sleepJob(cloud.baseUrl), quick)).toBe(EXIT.finished);
    expect(events(cloud.received)).toEqual(["started#0", "finished#1"]);
    expect(cloud.received.some((r) => r.path === "/api/worker/alive")).toBe(true);
    expect(new Set(cloud.received.map((r) => r.auth))).toEqual(new Set(["Bearer job-token"]));
    expect(cloud.received.at(-1)?.body).toMatchObject({ jobId: JOB, outcome: "inconclusive" });
  });

  it("stops at once when /alive answers 410, and reports nothing more", async () => {
    const cloud = await fakeCloud((r) => (r.path === "/api/worker/alive" ? 410 : undefined));
    expect(await runJob(sleepJob(cloud.baseUrl, 10), quick)).toBe(EXIT.stale);
    expect(events(cloud.received)).toEqual(["started#0"]);
  });

  it("stops at once when an event is answered 410", async () => {
    const cloud = await fakeCloud(() => 410);
    expect(await runJob(sleepJob(cloud.baseUrl), quick)).toBe(EXIT.stale);
    expect(cloud.received).toHaveLength(1);
  });

  it("sends an event again with the same seq when the Cloud couldn't take it", async () => {
    const cloud = await fakeCloud((r, i) => (r.method === "POST" && i === 0 ? 503 : undefined));
    expect(await runJob(sleepJob(cloud.baseUrl), quick)).toBe(EXIT.finished);
    expect(events(cloud.received)).toEqual(["started#0", "started#0", "finished#1"]);
  });

  it("reports an event the Cloud refused as a crash, and exits 1", async () => {
    const cloud = await fakeCloud((r) => (r.body?.kind === "finished" ? 400 : undefined));
    expect(await runJob(sleepJob(cloud.baseUrl), quick)).toBe(EXIT.failed);
    expect(events(cloud.received)).toEqual(["started#0", "finished#1", "failed#2"]);
    expect(cloud.received.at(-1)?.body).toMatchObject({
      error: { code: "crash", message: "POST /api/worker/events: 400" },
    });
  });

  it("refuses a payload that isn't a job, before saying anything", async () => {
    await expect(runJob({ type: "sleep", seconds: 1 })).rejects.toThrow(/jobId/);
  });
});
