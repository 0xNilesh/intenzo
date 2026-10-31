import { describe, expect, it } from "vitest";
import { z } from "zod";

import { GitHubError, githubClient, refPath } from "./api.ts";
import { fakeGitHub, json, notFound } from "./fake-github.ts";

const github = fakeGitHub();
const client = githubClient(async () => "ghs_test");
const Repo = z.object({ default_branch: z.string() });

describe("githubClient", () => {
  it("GETs JSON with the installation token and GitHub's headers", async () => {
    let headers: Headers | undefined;
    github.get("/repos/sumithprabhu/demo-shop", (request: Request) => {
      headers = request.headers;
      return { default_branch: "main", private: true };
    });
    expect(await client.get("/repos/sumithprabhu/demo-shop", Repo)).toEqual({
      default_branch: "main",
    });
    expect(headers?.get("authorization")).toBe("Bearer ghs_test");
    expect(headers?.get("accept")).toBe("application/vnd.github+json");
    expect(headers?.get("x-github-api-version")).toBe("2022-11-28");
  });

  it("answers null for a 404", async () => {
    github.get("/repos/sumithprabhu/gone", notFound);
    expect(await client.get("/repos/sumithprabhu/gone", Repo)).toBeNull();
  });

  it("fails with the request and GitHub's message for any other error", async () => {
    github.get("/repos/sumithprabhu/demo-shop", () =>
      json({ message: "Resource not accessible by integration" }, 403),
    );
    const failure = client.get("/repos/sumithprabhu/demo-shop", Repo);
    await expect(failure).rejects.toThrow(GitHubError);
    await expect(failure).rejects.toThrow(
      "GET /repos/sumithprabhu/demo-shop: 403 Resource not accessible by integration",
    );
  });

  it("refuses an answer without the fields Intenzo reads", async () => {
    github.get("/repos/sumithprabhu/demo-shop", { name: "demo-shop" });
    await expect(client.get("/repos/sumithprabhu/demo-shop", Repo)).rejects.toThrow(
      /default_branch/,
    );
  });

  it("reads a file's text at a ref", async () => {
    let accept: string | null = null;
    github.get("/repos/sumithprabhu/demo-shop/contents/.intenzo.yml", (request: Request) => {
      accept = request.headers.get("accept");
      return new Response("version: 1\n");
    });
    expect(await client.file("sumithprabhu/demo-shop", ".intenzo.yml", "main")).toBe(
      "version: 1\n",
    );
    expect(accept).toBe("application/vnd.github.raw+json");
    expect(github.calls).toEqual([
      "GET /repos/sumithprabhu/demo-shop/contents/.intenzo.yml?ref=main",
    ]);
  });
});

describe("refPath", () => {
  it.each([
    ["main", "main"],
    ["release/1.0", "release/1.0"],
    ["feat/a b#2", "feat/a%20b%232"],
  ])("%s → %s", (ref, path) => {
    expect(refPath(ref)).toBe(path);
  });
});
