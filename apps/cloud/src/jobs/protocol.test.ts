// T2.5a's Verify, automated: the real worker CLI, in its own process, runs a sleep job against the
// Cloud's worker routes served on a local port. Its events are stored; once its run is superseded,
// /alive answers 410 and the worker stops by itself (exit 3) without reporting anything more.
import { type ChildProcess, spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ensureRunGroup } from "../db/repos.ts";
import { jobEvents, runs } from "../db/schema.ts";
import { resetWithDemoShop, testDb } from "../db/test-db.ts";
import { advance } from "../runs/advance.ts";
import type { Fact } from "../runs/transition.ts";
import { signJobToken } from "./token.ts";
import { handleAlive, handleWorkerEvent, type WorkerApiDeps } from "./worker-api.ts";

const WORKER_CLI = fileURLToPath(new URL("../../../worker/src/main.ts", import.meta.url));
const SECRET = "a-job-secret-for-tests-only-0123456789";
const RUN = "00000000-0000-4000-8000-000000000001";
const JOB = "6f1d2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b";

let t: Awaited<ReturnType<typeof testDb>>;
let server: Server;
let worker: ChildProcess | undefined;
let groupId: number;
let ids = 0;

const happen = (fact: Fact) =>
  advance(t.db, groupId, fact, {
    now: new Date(),
    newRunId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
  });

beforeAll(async () => {
  t = await testDb();
  const deps: WorkerApiDeps = {
    db: t.db,
    secret: SECRET,
    now: () => new Date(),
    newRunId: () => crypto.randomUUID(),
    drain: async () => {},
    log: () => {},
  };
  // The two routes, as Next would serve them.
  server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === "string") headers.set(name, value);
    }
    const request = new Request(`http://127.0.0.1${req.url}`, {
      method: req.method,
      headers,
      ...(req.method === "POST" && { body }),
    });
    const route = { "/api/worker/events": handleWorkerEvent, "/api/worker/alive": handleAlive }[
      req.url ?? ""
    ];
    const response = route ? await route(request, deps) : new Response(null, { status: 404 });
    res.writeHead(response.status, { "content-type": "application/json" });
    res.end(await response.text());
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
});
afterAll(async () => {
  worker?.kill("SIGKILL");
  await new Promise((done) => server.close(done));
  await t.close();
});

describe("the job protocol, end to end (§9)", () => {
  it("stores a running job's events, then stops the worker with 410 once its run is superseded", async () => {
    const repo = await resetWithDemoShop(t.db);
    groupId = (await ensureRunGroup(t.db, repo.id, 7)).id;
    await happen({ kind: "pr_ready", trigger: "opened", headSha: "b4e35b0", draft: false });
    await happen({ kind: "preview_ready", sha: "b4e35b0", url: "https://demo-shop.vercel.app" });
    await t.db.update(runs).set({ currentJobId: JOB }).where(eq(runs.id, RUN));

    const { port } = server.address() as AddressInfo;
    const exp = Math.floor(Date.now() / 1000) + 600;
    const job = {
      type: "sleep",
      jobId: JOB,
      runId: RUN,
      deadlineAt: new Date(Date.now() + 300_000).toISOString(),
      callback: {
        baseUrl: `http://127.0.0.1:${port}`,
        token: signJobToken(SECRET, { jobId: JOB, runId: RUN, exp }),
      },
      seconds: 60,
      aliveEverySeconds: 0.1,
    };
    worker = spawn(process.execPath, [WORKER_CLI, "job"], { stdio: ["pipe", "ignore", "inherit"] });
    const exited = new Promise<number | null>((done) => worker!.on("exit", (code) => done(code)));
    worker.stdin!.end(JSON.stringify(job));

    // The worker starts and reports it…
    for (let waited = 0; (await t.db.select().from(jobEvents)).length === 0; waited += 50) {
      if (waited > 15_000) throw new Error("the worker never reported `started`");
      await sleep(50);
    }
    // …then a push supersedes its run, and it stops within one nap.
    await happen({ kind: "pr_pushed", headSha: "c5f46c1", draft: false });
    expect(await exited).toBe(3);

    const events = await t.db.select().from(jobEvents);
    expect(events.map((e) => `${e.kind}#${e.seq}`)).toEqual(["started#0"]);
    const [row] = await t.db.select().from(runs).where(eq(runs.id, RUN));
    expect(row).toMatchObject({ state: "done", outcome: "superseded" });
  }, 30_000);
});
