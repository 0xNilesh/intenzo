import { DEFAULT_DENY_TEXT, type IntenzoConfig } from "../schema/config.ts";

export type IsolationLevel = "ephemeral_user" | "reset_hook" | "none";

/**
 * How each execution gets its own server-side state (ARCHITECTURE §21.1):
 * - a session hook gives every execution a new user (best)
 * - a reset hook with a users pool runs executions one at a time, resetting before each
 * - anything else has no isolation, and every verdict is capped at inconclusive
 */
export function isolationLevel(config: IntenzoConfig): IsolationLevel {
  const { session_hook, reset_hook, users } = config.isolation;
  if (session_hook) return "ephemeral_user";
  if (reset_hook && users && users.length > 0) return "reset_hook";
  return "none";
}

/** Things worth telling the repo owner about a valid config, for the setup section of the report. */
export function configNotes(config: IntenzoConfig): string[] {
  const notes: string[] = [];
  const level = isolationLevel(config);
  const { session_hook, reset_hook, users } = config.isolation;
  if (!session_hook && reset_hook && !users) {
    notes.push("isolation.reset_hook does nothing without isolation.users (§21.1)");
  }
  if (level === "none") {
    notes.push(
      "no isolation: every verdict is capped at inconclusive. Add isolation.session_hook (§21.1)",
    );
  }
  if (config.baseline.mode === "none") {
    notes.push("baseline.mode is none: no before/after comparison");
  }
  return notes;
}

/**
 * The action denylist the navigator enforces (§29): the built-in list without the terms the repo
 * allows, plus the repo's additions. An addition wins over an allowance.
 */
export function denyText(config: IntenzoConfig): string[] {
  const norm = (t: string) => t.trim().toLowerCase();
  const allowed = new Set(config.guardrails.allow_text.map(norm));
  const all = [
    ...DEFAULT_DENY_TEXT.filter((t) => !allowed.has(t)),
    ...config.guardrails.deny_text.map(norm),
  ];
  return [...new Set(all)];
}
