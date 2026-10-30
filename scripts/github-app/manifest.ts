// The Intenzo GitHub App, as ARCHITECTURE §12 specifies it, in the shape of GitHub's App manifest
// (docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest). T0.4
// registers a throwaway App from it; T2.1 registers the real one.

/** §12 permissions. `contents: write` is deliberately not requested in v0. */
export const PERMISSIONS = {
  checks: "write",
  pull_requests: "write",
  issues: "write",
  deployments: "read",
  statuses: "write",
  contents: "read",
  metadata: "read",
} as const;

/**
 * §12 events. `installation` and `installation_repositories` are left out: every App receives them
 * by default and they can't be subscribed to.
 */
export const EVENTS = [
  "pull_request",
  "deployment_status",
  "issues",
  "issue_comment",
  "check_run",
] as const;

export interface ManifestOptions {
  name: string;
  /** Where GitHub POSTs webhooks. */
  hookUrl: string;
  /** Where GitHub sends the browser back, with a code, after the App is created. */
  redirectUrl: string;
  description: string;
}

export function buildManifest(options: ManifestOptions) {
  return {
    name: options.name,
    url: "https://github.com/0xNilesh/intenzo",
    description: options.description,
    hook_attributes: { url: options.hookUrl, active: true },
    redirect_url: options.redirectUrl,
    public: false,
    default_permissions: PERMISSIONS,
    default_events: EVENTS,
  };
}
