import { describe, expect, it } from "vitest";

import { fixtureName, parseKeepingBigIds, redact } from "./fixtures.ts";

describe("redact", () => {
  it("replaces emails under email keys, keeps logins, ids and ssh URLs", () => {
    const payload = {
      sender: { login: "octocat", id: 1 },
      head_commit: { author: { name: "Octo", email: "octo@cat.dev" } },
      repository: { ssh_url: "git@github.com:octo/cat.git" },
    };
    expect(redact(payload)).toEqual({
      sender: { login: "octocat", id: 1 },
      head_commit: { author: { name: "Octo", email: "user@example.com" } },
      repository: { ssh_url: "git@github.com:octo/cat.git" },
    });
  });

  it("removes anything shaped like a GitHub token, anywhere", () => {
    const token = `ghs_${"a".repeat(36)}`;
    expect(redact({ comment: { body: `token ${token} here` } })).toEqual({
      comment: { body: "token <redacted-token> here" },
    });
    expect(redact([`github_pat_${"B".repeat(30)}`])).toEqual(["<redacted-token>"]);
  });
});

describe("fixtureName", () => {
  it.each([
    [
      "deployment_status",
      "created",
      { deployment_status: { state: "success" }, deployment: { environment: "Preview" } },
      "deployment_status.success.preview",
    ],
    [
      "deployment_status",
      "created",
      { deployment_status: { state: "pending" }, deployment: { environment: "Preview – shop" } },
      "deployment_status.pending.preview-shop",
    ],
    [
      "check_run",
      "requested_action",
      { requested_action: { identifier: "approve" }, check_run: { status: "in_progress" } },
      "check_run.requested_action.approve.in-progress",
    ],
    [
      "check_run",
      "created",
      { check_run: { app: { slug: "github-actions" } } },
      "check_run.created.github-actions",
    ],
    [
      "issue_comment",
      "created",
      {
        comment: {
          user: { type: "Bot", login: "intenzo-demo[bot]" },
          performed_via_github_app: { slug: "intenzo-demo" },
        },
      },
      "issue_comment.created.bot-intenzo-demo",
    ],
    [
      "issue_comment",
      "created",
      { comment: { user: { type: "Bot", login: "vercel[bot]" } } },
      "issue_comment.created.bot-vercel-bot",
    ],
    [
      "issue_comment",
      "created",
      { comment: { user: { type: "User", login: "octocat" } } },
      "issue_comment.created.user",
    ],
    ["pull_request", "opened", {}, "pull_request.opened"],
    ["ping", null, {}, "ping.none"],
  ])("%s %s → %s", (event, action, payload, name) => {
    expect(fixtureName(event, action, payload)).toBe(name);
  });
});

describe("parseKeepingBigIds", () => {
  it("keeps delivery ids beyond 2^53 exact, where JSON.parse would round them", () => {
    const text = '{"id":3851222250984308717,"installation":176892286,"ratio":1.5}';
    expect(String(JSON.parse(text).id)).not.toBe("3851222250984308717"); // the bug
    expect(parseKeepingBigIds(text)).toEqual({
      id: "3851222250984308717",
      installation: 176892286,
      ratio: 1.5,
    });
  });
});
