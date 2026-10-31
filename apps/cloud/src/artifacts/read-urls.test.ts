import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { artifactUrls, publicUrl, READ_URL_TTL_MS, storeIdOf } from "./read-urls.ts";

describe("storeIdOf and publicUrl", () => {
  it.each([
    [{ storeId: "store_KlFPIscDV04whPTV" }, "KlFPIscDV04whPTV"],
    [{ storeId: "KlFPIscDV04whPTV" }, "KlFPIscDV04whPTV"],
    [{ token: "vercel_blob_rw_KlFPIscDV04whPTV_notarealsecret" }, "KlFPIscDV04whPTV"],
  ])("%j → %s", (auth, id) => {
    expect(storeIdOf(auth)).toBe(id);
  });

  it("puts a public blob at its store's lowercased host, as T2.6's upload answered", () => {
    expect(
      publicUrl({ storeId: "store_KlFPIscDV04whPTV" }, "runs/r1/C1/pr/take-1/evidence.gif"),
    ).toBe(
      "https://klfpiscdv04whptv.public.blob.vercel-storage.com/runs/r1/C1/pr/take-1/evidence.gif",
    );
  });
});

describe("artifactUrls", () => {
  // @vercel/blob's own undici can't be intercepted by msw: a local stand-in, as in upload-tokens.
  const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  let server: Server;
  let asked: { pathname: string; operations: string[]; validUntil: number }[] = [];
  beforeAll(async () => {
    server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw) as (typeof asked)[number];
      asked.push(body);
      const scope = { storeId: "store_Private123", ...body };
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          delegationToken: `${b64(scope)}.sig`,
          clientSigningToken: "k",
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

  const NOW = 1_900_000_000_000;
  const urls = artifactUrls(
    {
      public: { storeId: "store_KlFPIscDV04whPTV" },
      private: { token: "vercel_blob_rw_Private123_notarealsecret" },
    },
    () => NOW,
  );
  const video = {
    store: "private" as const,
    path: "runs/r1/C2/pr/take-1/human.mp4",
    contentType: "video/mp4",
  };

  it("signs a private video for an hour, read-only, for its path alone", async () => {
    asked = [];
    const url = new URL((await urls(video))!);
    expect(asked).toEqual([
      { pathname: video.path, operations: ["get"], validUntil: NOW + READ_URL_TTL_MS },
    ]);
    expect(url.host).toBe("private123.private.blob.vercel-storage.com");
    expect(url.pathname).toBe(`/${video.path}`);
  });

  it("links a public file directly, without asking Blob", async () => {
    asked = [];
    const gif = {
      store: "public" as const,
      path: "runs/r1/C2/evidence.gif",
      contentType: "image/gif",
    };
    expect(await urls(gif)).toBe(
      "https://klfpiscdv04whptv.public.blob.vercel-storage.com/runs/r1/C2/evidence.gif",
    );
    expect(asked).toEqual([]);
  });

  it("has nothing for a store that isn't configured", async () => {
    const none = artifactUrls({ public: null, private: null });
    expect(await none(video)).toBeNull();
  });
});
