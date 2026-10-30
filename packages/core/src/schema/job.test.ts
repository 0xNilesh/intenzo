import { describe, expect, it } from "vitest";

import { WorkerEvent } from "./events.ts";
import { ContextBundle, VerifyJob } from "./job.ts";
import { issues } from "./test-helpers.ts";

const sha = "0123456789abcdef0123456789abcdef01234567";
const jobId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

const bundle = {
  pr: {
    number: 128,
    title: "Discount codes",
    body: "Fixes #42",
    headSha: sha,
    baseRef: "main",
    isFork: false,
    isBot: true,
  },
  ticket: { source: "github_issue", ref: "#42", title: "Discount codes", body: "…", comments: [] },
  images: [],
  media: [{ store: "private", path: "bundles/r1/pm-ticket.mp4", contentType: "video/mp4" }],
  diff: {
    files: [
      { path: "app/cart/total.ts", status: "modified", additions: 12, deletions: 3, patch: "@@ …" },
      { path: "public/logo.png", status: "modified", additions: 0, deletions: 0 },
    ],
  },
  hints: { start: "/cart" },
};

const job = {
  jobId,
  runId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  deadlineAt: "2026-10-30T18:00:00Z",
  callback: { baseUrl: "https://intenzo.dev", token: "jwt" },
  config: { version: 1 },
  type: "verify",
  bundleUrl: "https://blob.example/bundles/r1.json",
  intent: null,
  prUrl: "https://demo-shop-git-pr-128.vercel.app",
  baseUrl: "https://demo-shop-git-main.vercel.app",
  baseSha: sha,
  secrets: { bypass: "x", hookSecret: "y" },
  cachedPaths: [],
};

describe("ContextBundle", () => {
  it("parses a PR with a video ticket, filling hint and media defaults", () => {
    const parsed = ContextBundle.parse(bundle);
    expect(parsed.hints?.data).toEqual([]);
    expect(parsed.mediaUnavailable).toBe(false);
  });

  it("accepts a PR without a ticket", () => {
    expect(ContextBundle.parse({ ...bundle, ticket: null }).ticket).toBeNull();
  });

  it("requires a full head sha", () => {
    const short = { ...bundle, pr: { ...bundle.pr, headSha: "0123abc" } };
    expect(issues(ContextBundle, short)).toEqual([
      "pr.headSha: must be a full 40-character commit sha",
    ]);
  });
});

describe("VerifyJob", () => {
  it("parses a job and applies the config defaults", () => {
    const parsed = VerifyJob.parse(job);
    expect(parsed.config.policy.max_agent_attempts).toBe(3);
  });

  it("carries no secrets for a fork PR", () => {
    expect(VerifyJob.parse({ ...job, secrets: null }).secrets).toBeNull();
  });

  it("validates the ids, URLs and deadline", () => {
    expect(issues(VerifyJob, { ...job, jobId: "job-1" })[0]).toMatch(/^jobId: /);
    expect(issues(VerifyJob, { ...job, prUrl: "not a url" })[0]).toMatch(/^prUrl: /);
    expect(issues(VerifyJob, { ...job, deadlineAt: "tomorrow" })[0]).toMatch(/^deadlineAt: /);
  });

  it("re-runs only valid criterion ids", () => {
    expect(VerifyJob.parse({ ...job, only: ["C2"] }).only).toEqual(["C2"]);
    expect(issues(VerifyJob, { ...job, only: ["two"] })[0]).toMatch(/^only\.0: /);
  });

  it("rejects a config typo inside the job, with its path", () => {
    expect(issues(VerifyJob, { ...job, config: { version: 1, polcy: {} } })).toEqual([
      'config: Unrecognized key: "polcy"',
    ]);
  });
});

describe("WorkerEvent", () => {
  it.each([
    { kind: "started", jobId, seq: 0 },
    { kind: "failed", jobId, seq: 9, error: { code: "infra_timeout", message: "killed at 870 s" } },
    {
      kind: "finished",
      jobId,
      seq: 8,
      outcome: "fail",
      costUsd: 0.31,
      timings: { verify: 112_000 },
    },
    {
      kind: "criterion_evidence",
      jobId,
      seq: 5,
      criterionId: "C2",
      gif: { store: "public", path: "runs/r1/C2/pr/take-1/evidence.gif", contentType: "image/gif" },
      still: { store: "public", path: "runs/r1/C2/pr/take-1/still.png", contentType: "image/png" },
    },
    {
      kind: "changes_done",
      jobId,
      seq: 6,
      changes: [{ route: "/cart", description: 'Checkout → "Continue"', confidence: 0.9 }],
    },
  ])("parses a $kind event", (event) => {
    expect(WorkerEvent.parse(event).kind).toBe(event.kind);
  });

  it("rejects an unknown kind", () => {
    expect(issues(WorkerEvent, { kind: "progress", jobId, seq: 1 })[0]).toMatch(/^kind: /);
  });

  it("rejects a negative or fractional sequence number", () => {
    expect(issues(WorkerEvent, { kind: "started", jobId, seq: -1 })[0]).toMatch(/^seq: /);
    expect(issues(WorkerEvent, { kind: "started", jobId, seq: 1.5 })[0]).toMatch(/^seq: /);
  });
});
