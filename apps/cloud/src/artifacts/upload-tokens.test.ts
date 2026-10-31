import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { takePath } from "@intenzo/core";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ensureRunGroup } from "../db/repos.ts";
import { runs } from "../db/schema.ts";
import { resetWithDemoShop, testDb } from "../db/test-db.ts";
import { signJobToken } from "../jobs/token.ts";
import { advance } from "../runs/advance.ts";
import type { Fact } from "../runs/transition.ts";
import {
  blobSigner,
  type FileToSign,
  handleUploadTokens,
  insideRun,
  UPLOAD_URL_TTL_MS,
} from "./upload-tokens.ts";

const SECRET = "a-job-secret-for-tests-only-0123456789";
const NOW = new Date("2026-10-31T09:00:00.000Z");
const RUN = "00000000-0000-4000-8000-000000000001";
const JOB = "6f1d2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b";
const TOKEN = signJobToken(SECRET, { jobId: JOB, runId: RUN, exp: NOW.getTime() / 1000 + 600 });

let t: Awaited<ReturnType<typeof testDb>>;
let groupId: number;
let ids: number;
let signed: { file: FileToSign; validUntil: number }[];

beforeAll(async () => {
  t = await testDb();
});
afterAll(() => t.close());
beforeEach(async () => {
  const repo = await resetWithDemoShop(t.db);
  groupId = (await ensureRunGroup(t.db, repo.id, 7)).id;
  ids = 0;
  signed = [];
  await happen({ kind: "pr_ready", trigger: "opened", headSha: "b4e35b0", draft: false });
  await happen({ kind: "preview_ready", sha: "b4e35b0", url: "https://demo-shop-x.vercel.app" });
  await t.db.update(runs).set({ currentJobId: JOB }).where(eq(runs.id, RUN));
});

const happen = (fact: Fact) =>
  advance(t.db, groupId, fact, {
    now: NOW,
    newRunId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
  });
const ask = async (body: unknown, token: string | null = TOKEN) => {
  const response = await handleUploadTokens(
    new Request("https://intenzo-cloud.vercel.app/api/worker/upload-tokens", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token && { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify(body),
    }),
    {
      db: t.db,
      secret: SECRET,
      now: () => NOW,
      sign: async (file, validUntil) => {
        signed.push({ file, validUntil });
        return `https://vercel.com/api/blob/?pathname=${encodeURIComponent(file.path)}&signed=1`;
      },
    },
  );
  return { status: response.status, body: (await response.json()) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
};
const video = (take = 1) => ({
  store: "private",
  path: takePath(RUN, "C2", "pr", take, "human.mp4"),
  contentType: "video/mp4",
});

describe("POST /api/worker/upload-tokens (§28)", () => {
  it("gives a presigned URL per file, for its exact path, valid 15 minutes", async () => {
    const gif = { store: "public", path: `runs/${RUN}/C2/evidence.gif`, contentType: "image/gif" };
    const { status, body } = await ask({ files: [video(), gif] });
    expect(status).toBe(200);
    expect(body.uploads.map((u: { path: string }) => u.path)).toEqual([video().path, gif.path]);
    expect(body.uploads[0].uploadUrl).toContain(encodeURIComponent(video().path));
    expect(signed.map((s) => [s.file.store, s.file.path, s.file.maxBytes])).toEqual([
      ["private", video().path, 500e6],
      ["public", gif.path, 20e6],
    ]);
    expect(signed[0]!.validUntil).toBe(NOW.getTime() + UPLOAD_URL_TTL_MS);
  });

  it("gives a second take its own path", async () => {
    await ask({ files: [video(1), video(2)] });
    expect(new Set(signed.map((s) => s.file.path)).size).toBe(2);
  });

  it.each([
    ["another run's path", `runs/00000000-0000-4000-8000-000000000999/C2/pr/take-1/human.mp4`],
    ["a path outside runs/", "bundles/context.json"],
    ["a climb out of the run", `runs/${RUN}/../other/take-1/human.mp4`],
    ["an absolute path", `/runs/${RUN}/C2/pr/take-1/human.mp4`],
    ["an empty segment", `runs/${RUN}//take-1/human.mp4`],
    ["odd characters", `runs/${RUN}/C2/pr/take-1/human mp4?x=1`],
  ])("refuses %s with 403, and signs nothing", async (_name, path) => {
    const { status } = await ask({ files: [video(), { ...video(), path }] });
    expect(status).toBe(403);
    expect(signed).toEqual([]);
  });

  it("refuses a file its store doesn't take: no videos in the public store", async () => {
    const { status, body } = await ask({ files: [{ ...video(), store: "public" }] });
    expect(status).toBe(403);
    expect(body.error).toBe("the public store doesn't take video/mp4");
  });

  it.each([
    ["no files", { files: [] }],
    ["more than 20", { files: Array.from({ length: 21 }, (_, i) => video(i + 1)) }],
    ["no list", { path: video().path }],
  ])("answers 400 to %s", async (_name, body) => {
    expect((await ask(body)).status).toBe(400);
  });

  it("answers 401 without a job token and 410 to a job that isn't current", async () => {
    expect((await ask({ files: [video()] }, null)).status).toBe(401);
    await happen({ kind: "pr_pushed", headSha: "c5f46c1", draft: false });
    expect((await ask({ files: [video()] })).status).toBe(410);
    expect(signed).toEqual([]);
  });
});

describe("insideRun", () => {
  it("accepts takePath's paths", () => {
    expect(insideRun(takePath(RUN, "C1", "base", 3, "trace.zip"), RUN)).toBe(true);
  });
});

describe("blobSigner", () => {
  // @vercel/blob calls its control API with its own copy of undici, which msw can't intercept, so
  // the test points the SDK at a local stand-in through its documented VERCEL_BLOB_API_URL override.
  const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  let server: Server;
  let requested: { path: string; body: unknown }[];
  beforeAll(async () => {
    server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw || "null") as {
        pathname: string;
        operations: string[];
        validUntil: number;
      };
      requested.push({ path: req.url ?? "", body });
      // Like the real API, it scopes the delegation to what was asked for.
      const scope = {
        storeId: "store_TestStore123",
        pathname: body.pathname,
        operations: body.operations,
        validUntil: body.validUntil,
      };
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          delegationToken: `${b64(scope)}.signature`,
          clientSigningToken: "a-fake-signing-key",
          validUntil: body.validUntil,
        }),
      );
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    process.env.VERCEL_BLOB_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    delete process.env.VERCEL_BLOB_API_URL;
    await new Promise((done) => server.close(done));
  });
  beforeEach(() => {
    requested = [];
  });

  it("asks Blob for a token scoped to the one path and to PUT, and presigns a URL that can't overwrite", async () => {
    const validUntil = Date.now() + 600_000;
    const url = await blobSigner({
      public: null,
      private: { token: "vercel_blob_rw_TestStore123_notarealtoken" },
    })(
      { store: "private", path: video().path, contentType: "video/mp4", maxBytes: 500e6 },
      validUntil,
    );

    expect(requested).toEqual([
      {
        path: "/signed-token",
        body: expect.objectContaining({
          pathname: video().path,
          operations: ["put"],
          validUntil,
          allowedContentTypes: ["video/mp4"],
          maximumSizeInBytes: 500e6,
        }),
      },
    ]);
    const query = Object.fromEntries(new URL(url).searchParams);
    // The upload can't replace an earlier take, and keeps its exact path; both are signed.
    expect(query).toMatchObject({
      pathname: video().path,
      "vercel-blob-allow-overwrite": "false",
      "vercel-blob-add-random-suffix": "false",
      "vercel-blob-allowed-content-types": "video/mp4",
    });
    expect(query["vercel-blob-signature"]).toBeTruthy();
  });

  it("refuses a store that isn't configured", async () => {
    const sign = blobSigner({ public: null, private: null });
    await expect(
      sign({ store: "public", path: "x", contentType: "image/gif", maxBytes: 1 }, 1),
    ).rejects.toThrow("no public Blob store is configured");
    expect(requested).toEqual([]);
  });
});
