import { dig } from "../../probe/lib/json.ts";

const TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g;

/**
 * JSON.parse, except integers beyond 2^53 keep their exact digits as strings. GitHub's webhook
 * delivery ids are that big, and plain JSON.parse rounds them, so the lookup hits the wrong id.
 */
export function parseKeepingBigIds(text: string): unknown {
  return JSON.parse(text, (_key, value: unknown, context?: { source?: string }) =>
    typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value)
      ? (context?.source ?? String(value))
      : value,
  );
}

/**
 * A copy of a webhook payload that's safe to commit: values under an `email` key become
 * user@example.com, and anything shaped like a GitHub token is removed. Logins and ids are kept;
 * they're public and the tests need real shapes.
 */
export function redact(value: unknown, key = ""): unknown {
  if (typeof value === "string") {
    if (/email/i.test(key) && value.includes("@")) return "user@example.com";
    return value.replace(TOKEN, "<redacted-token>");
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, key));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]));
  }
  return value;
}

const slug = (text: unknown): string =>
  String(text ?? "none")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/**
 * A stable fixture name per kind of delivery, e.g. `deployment_status.success.preview`,
 * `check_run.requested_action.approve.completed` or `issue_comment.created.bot-intenzo-demo`.
 */
export function fixtureName(event: string, action: string | null, payload: unknown): string {
  const base = `${event}.${action ?? "none"}`;
  switch (event) {
    case "deployment_status":
      return `${event}.${slug(dig(payload, "deployment_status", "state"))}.${slug(dig(payload, "deployment", "environment"))}`;
    case "check_run": {
      // An App gets every check run's events, GitHub Actions jobs' included, so the name says
      // whose run it was. A button press also says whether the run had finished.
      const id = dig(payload, "requested_action", "identifier");
      const status = dig(payload, "check_run", "status");
      return id
        ? `${base}.${slug(id)}.${slug(status)}`
        : `${base}.${slug(dig(payload, "check_run", "app", "slug"))}`;
    }
    case "issue_comment": {
      const user = dig(payload, "comment", "user");
      const app = dig(payload, "comment", "performed_via_github_app", "slug");
      return `${base}.${dig(user, "type") === "Bot" ? `bot-${slug(app ?? dig(user, "login"))}` : "user"}`;
    }
    default:
      return base;
  }
}
