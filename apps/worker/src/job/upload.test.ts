import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { takePath } from "@intenzo/core";
import { afterEach, describe, expect, it } from "vitest";

import { jobClient, StaleJobError } from "./client.ts";
import { uploadArtifacts } from "./upload.ts";

const JOB = "6f1d2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b";
const RUN = "ea44d35d-4baa-4f81-ac92-08285fae4058";

let server: Server | undefined;
afterEach(() => new Promise<void>((done) => (server ? server.close(() => done()) : done())));

/**
 * One local server playing both parts: the Cloud's upload-tokens route, which hands out URLs on the
 * same server, and Blob, which stores what is PUT there.
 */
async function cloudAndBlob(answers: { tokens?: number; put?: number } = {}) {
  const stored = new Map<string, { contentType: string | undefined; bytes: Buffer }>();
  let base = "";
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    if (req.url === "/api/worker/upload-tokens") {
      const { files } = JSON.parse(body.toString()) as { files: { path: string }[] };
      const uploads = files.map((f) => ({
        ...f,
        uploadUrl: `${base}/blob/${f.path}?signed=1`,
        validUntil: "x",
      }));
      res.writeHead(answers.tokens ?? 200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ uploads }));
    }
    if (req.method === "PUT" && req.url?.startsWith("/blob/")) {
      const path = new URL(req.url, base).pathname.slice("/blob/".length);
      if (answers.put) return res.writeHead(answers.put).end("conflict: the blob already exists");
      stored.set(path, { contentType: req.headers["content-type"], bytes: body });
      return res.writeHead(200).end("{}");
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  const client = jobClient(
    { jobId: JOB, callback: { baseUrl: base, token: "job-token" } },
    { retryDelayMs: 1 },
  );
  return { client, stored };
}

const video = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);
const gif = new Uint8Array([71, 73, 70, 56, 57, 97]);

describe("uploadArtifacts (§28)", () => {
  it("PUTs each file to its own presigned URL and returns ArtifactRefs", async () => {
    const { client, stored } = await cloudAndBlob();
    const files = [
      {
        store: "private" as const,
        path: takePath(RUN, "C2", "pr", 1, "human.mp4"),
        contentType: "video/mp4",
        body: video,
      },
      {
        store: "public" as const,
        path: `runs/${RUN}/C2/evidence.gif`,
        contentType: "image/gif",
        body: gif,
      },
    ];
    expect(await uploadArtifacts(client, files)).toEqual([
      { store: "private", path: files[0]!.path, contentType: "video/mp4", bytes: 8 },
      { store: "public", path: files[1]!.path, contentType: "image/gif", bytes: 6 },
    ]);
    expect(stored.get(files[0]!.path)).toEqual({
      contentType: "video/mp4",
      bytes: Buffer.from(video),
    });
    expect(stored.get(files[1]!.path)?.contentType).toBe("image/gif");
  });

  it("stops on a 410 for the URLs, uploading nothing", async () => {
    const { client, stored } = await cloudAndBlob({ tokens: 410 });
    const file = {
      store: "private" as const,
      path: takePath(RUN, "C2", "pr", 1, "human.mp4"),
      contentType: "video/mp4",
      body: video,
    };
    await expect(uploadArtifacts(client, [file])).rejects.toThrow(StaleJobError);
    expect(stored.size).toBe(0);
  });

  it("fails with Blob's answer when an upload is refused, such as one onto an existing take", async () => {
    const { client } = await cloudAndBlob({ put: 409 });
    const file = {
      store: "private" as const,
      path: takePath(RUN, "C2", "pr", 1, "human.mp4"),
      contentType: "video/mp4",
      body: video,
    };
    await expect(uploadArtifacts(client, [file])).rejects.toThrow(
      `uploading ${file.path}: 409 conflict: the blob already exists`,
    );
  });
});
