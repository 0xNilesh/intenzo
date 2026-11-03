import { createHash } from "node:crypto";

import type { ArtifactRef } from "@intenzo/core";
import { combinedHash, prCriteriaTicket, ticketHash } from "@intenzo/core/intent";
import { describe, expect, it } from "vitest";

import type { GitHub } from "../github/api.ts";
import { buildBundle } from "./build.ts";

const RUN = "00000000-0000-4000-8000-000000000001";
const REPO = "sumithprabhu/demo-shop";
const VIDEO_URL = "https://github.com/user-attachments/assets/cebd0ef1-5bd1-4c98-9f2d-607b0b328e3c";
const VIDEO = new Uint8Array([1, 2, 3, 4]);

/** GitHub as the demo PR and ticket #5 answer, with what each test changes. */
function fakeGitHub(
  over: {
    body?: string | null;
    download?: Uint8Array | null;
    issueIsPr?: boolean;
    /** GitHub's base.repo.private; null leaves the field out. demo-shop is public. */
    repoPrivate?: boolean | null;
  } = {},
) {
  const asked: string[] = [];
  const answers: Record<string, unknown> = {
    [`/repos/${REPO}/pulls/7`]: {
      title: "Discount codes",
      body: over.body === undefined ? "Implements the ticket. Closes #5" : over.body,
      head: { sha: "a".repeat(40) },
      base: {
        ref: "main",
        ...(over.repoPrivate !== null && { repo: { private: over.repoPrivate ?? false } }),
      },
      user: { type: "User" },
    },
    [`/repos/${REPO}/issues/5`]: {
      title: "Discount codes",
      body: "The details are in the screen recording below.",
      body_html: `<p><a href="${VIDEO_URL}">video</a></p>`,
      ...(over.issueIsPr && { pull_request: {} }),
    },
    [`/repos/${REPO}/issues/5/comments?per_page=20`]: [{ body: "Thanks!" }, { body: null }],
    [`/repos/${REPO}/issues/9`]: {
      title: "Undo remove",
      body: "## Acceptance criteria\n- [ ] Undo restores the item",
      body_html: "<h2>Acceptance criteria</h2>",
    },
    [`/repos/${REPO}/issues/9/comments?per_page=20`]: [],
    [`/repos/${REPO}/pulls/7/files?per_page=100`]: [
      {
        filename: "lib/cart.ts",
        status: "modified",
        additions: 15,
        deletions: 2,
        patch: Array.from({ length: 450 }, (_, i) => `+line ${i}`).join("\n"),
      },
      { filename: "public/logo.png", status: "added", additions: 0, deletions: 0 },
    ],
  };
  const github: GitHub = {
    async get(path, schema, accept) {
      asked.push(`${path}${accept ? ` (${accept})` : ""}`);
      return path in answers ? schema.parse(answers[path]) : null;
    },
    async send() {
      throw new Error("the bundle only reads");
    },
    async file() {
      return null;
    },
    async download(url) {
      asked.push(`download ${url}`);
      return (
        over.download === undefined ? VIDEO : over.download
      ) as Uint8Array<ArrayBuffer> | null;
    },
  };
  return { github, asked };
}

function fakeStore() {
  const stored = new Map<string, { body: Uint8Array | string; type: string }>();
  return {
    stored,
    put: async (
      path: string,
      body: Uint8Array | string,
      contentType: string,
    ): Promise<ArtifactRef> => {
      stored.set(path, { body, type: contentType });
      return { store: "private", path, contentType };
    },
    sign: async (ref: ArtifactRef) => `https://private.blob.example/${ref.path}?sig=1`,
  };
}

describe("buildBundle (§8, §17.2)", () => {
  it("gathers the PR, its ticket with the recording, and the diff, and signs them for the worker", async () => {
    const { github, asked } = fakeGitHub();
    const store = fakeStore();
    const built = await buildBundle(
      { github, ...store, log: () => {} },
      { repo: REPO, prNumber: 7, runId: RUN, isFork: false },
    );

    expect(asked).toContain(`/repos/${REPO}/issues/5 (application/vnd.github.full+json)`);
    expect(asked).toContain(`download ${VIDEO_URL}`);
    expect(built.bundleUrl).toBe(`https://private.blob.example/runs/${RUN}/bundle.json?sig=1`);
    expect(built.bundle.ticket).toEqual({
      source: "github_issue",
      ref: "#5",
      title: "Discount codes",
      body: "The details are in the screen recording below.",
      comments: ["Thanks!"],
    });
    expect(built.bundle.media).toEqual([
      { store: "private", path: `runs/${RUN}/ticket/media-1.mp4`, contentType: "video/mp4" },
    ]);
    expect(built.bundle.mediaUrls).toEqual([
      `https://private.blob.example/runs/${RUN}/ticket/media-1.mp4?sig=1`,
    ]);
    expect(store.stored.get(`runs/${RUN}/ticket/media-1.mp4`)?.body).toEqual(VIDEO);
    // §8: patches cut at 400 lines; a binary file has none.
    expect(built.bundle.diff.files[0]!.patch!.split("\n")).toHaveLength(400);
    expect(built.bundle.diff.files[1]).not.toHaveProperty("patch");
    // §28: a public repo's evidence may go to the public store.
    expect(built.repoPublic).toBe(true);
    // The stored bundle is the one returned.
    expect(JSON.parse(store.stored.get(`runs/${RUN}/bundle.json`)!.body as string)).toEqual(
      built.bundle,
    );
    // §18: the same hash the worker's intent step computes, so the intent can be reused.
    const mediaHash = createHash("sha256").update(VIDEO).digest("hex");
    expect(built.ticketHash).toBe(
      ticketHash(
        {
          ref: "#5",
          title: "Discount codes",
          body: "The details are in the screen recording below.",
          comments: ["Thanks!"],
        },
        [mediaHash],
      ),
    );
  });

  it.each([
    ["a private repo", true],
    ["a reply that doesn't say", null],
  ])("keeps the evidence of %s out of the public store (§28)", async (_, repoPrivate) => {
    const { github } = fakeGitHub({ repoPrivate });
    const built = await buildBundle(
      { github, ...fakeStore(), log: () => {} },
      { repo: REPO, prNumber: 7, runId: RUN, isFork: false },
    );
    expect(built.repoPublic).toBe(false);
  });

  it("goes on without the recording when it can't be downloaded, and says so", async () => {
    const lines: string[] = [];
    const { github } = fakeGitHub({ download: null });
    const built = await buildBundle(
      { github, ...fakeStore(), log: (l) => lines.push(l) },
      { repo: REPO, prNumber: 7, runId: RUN, isFork: false },
    );
    expect(built.bundle).toMatchObject({ media: [], mediaUrls: [], mediaUnavailable: true });
    expect(built.bundle.ticket?.ref).toBe("#5");
    expect(lines).toEqual(["PR #7: ticket #5's recording couldn't be downloaded"]);
  });

  it.each([
    ["a PR that names no ticket", { body: "Just a change." }],
    ["a PR with no body", { body: null }],
    ["a #5 that is itself a PR", { issueIsPr: true }],
  ])("has no ticket for %s", async (_case, over) => {
    const { github } = fakeGitHub(over);
    const built = await buildBundle(
      { github, ...fakeStore(), log: () => {} },
      { repo: REPO, prNumber: 7, runId: RUN, isFork: true },
    );
    expect(built.bundle.ticket).toBeNull();
    expect(built.ticketHash).toBeNull();
    expect(built.bundle.pr.isFork).toBe(true);
  });
});

describe("a PR with several intents (§17.2)", () => {
  const BODY = `## Intent
Closes #5
Closes #9

## Acceptance criteria
- [ ] The header's cart count updates after Undo

## Test hints
- start: /cart
- data: valid discount code: SAVE10`;

  it("gathers every ticket with its own recording, the PR's criteria and its hints", async () => {
    const { github, asked } = fakeGitHub({ body: BODY });
    const store = fakeStore();
    const built = await buildBundle(
      { github, put: store.put, sign: store.sign, log: () => {} },
      { repo: REPO, prNumber: 7, runId: RUN, isFork: false },
    );
    const { bundle } = built;
    expect(bundle.tickets.map((t) => [t.ref, t.title, t.video])).toEqual([
      ["#5", "Discount codes", 0],
      ["#9", "Undo remove", null],
    ]);
    expect(bundle.ticket).toMatchObject({ ref: "#5" });
    expect(bundle.prCriteria).toEqual(["The header's cart count updates after Undo"]);
    expect(bundle.hints).toEqual({ start: "/cart", data: ["valid discount code: SAVE10"] });
    expect(bundle.mediaUrls).toHaveLength(1);
    expect(asked).toContain(`/repos/${REPO}/issues/9 (application/vnd.github.full+json)`);

    const video = createHash("sha256").update(VIDEO).digest("hex");
    expect(built.ticketHash).toBe(
      combinedHash([
        {
          source: "#5",
          hash: ticketHash(
            {
              ref: "#5",
              title: "Discount codes",
              body: "The details are in the screen recording below.",
              comments: ["Thanks!"],
            },
            [video],
          ),
        },
        {
          source: "#9",
          hash: ticketHash({
            ref: "#9",
            title: "Undo remove",
            body: "## Acceptance criteria\n- [ ] Undo restores the item",
            comments: [],
          }),
        },
        {
          source: "pr",
          hash: ticketHash(
            prCriteriaTicket("Discount codes", ["The header's cart count updates after Undo"]),
          ),
        },
      ]),
    );
  });

  it("keeps a one-ticket PR's hash as before, so its cached intent is reused", async () => {
    const { github } = fakeGitHub();
    const store = fakeStore();
    const built = await buildBundle(
      { github, put: store.put, sign: store.sign, log: () => {} },
      { repo: REPO, prNumber: 7, runId: RUN, isFork: false },
    );
    const video = createHash("sha256").update(VIDEO).digest("hex");
    expect(built.ticketHash).toBe(
      ticketHash(
        {
          ref: "#5",
          title: "Discount codes",
          body: "The details are in the screen recording below.",
          comments: ["Thanks!"],
        },
        [video],
      ),
    );
    expect(built.bundle.tickets).toHaveLength(1);
    expect(built.bundle.prCriteria).toEqual([]);
    expect(built.bundle.hints).toBeNull();
  });
});
