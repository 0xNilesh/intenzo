import { describe, expect, it } from "vitest";

import { buildManifest, EVENTS, PERMISSIONS } from "./manifest.ts";

describe("the §12 App manifest", () => {
  it("requests exactly the §12 permissions, and no contents write", () => {
    expect(PERMISSIONS).toEqual({
      checks: "write",
      pull_requests: "write",
      issues: "write",
      deployments: "read",
      statuses: "write",
      contents: "read",
      metadata: "read",
    });
  });

  it("subscribes to the §12 events GitHub lets an App choose", () => {
    expect([...EVENTS].sort()).toEqual([
      "check_run",
      "deployment_status",
      "issue_comment",
      "issues",
      "pull_request",
    ]);
  });

  it("builds a private App with an active webhook and the redirect back", () => {
    const manifest = buildManifest({
      name: "intenzo-t04-abc123",
      hookUrl: "https://example.com/hook",
      redirectUrl: "http://127.0.0.1:5000/callback",
      description: "test",
    });
    expect(manifest).toMatchObject({
      name: "intenzo-t04-abc123",
      public: false,
      hook_attributes: { url: "https://example.com/hook", active: true },
      redirect_url: "http://127.0.0.1:5000/callback",
    });
  });
});
