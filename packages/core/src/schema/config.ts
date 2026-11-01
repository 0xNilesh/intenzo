import { z } from "zod";

import { SameOriginPath } from "./navigation.ts";

// The repo's .intenzo.yml (ARCHITECTURE §10). Every level is strict: an unknown key is an error, so a
// typo can't silently fall back to a default. Sections use prefault() so a missing section still
// gets its inner defaults (zod 4's default() would skip them).

/** Credentials are referenced by the name of a secret stored in Intenzo, never written in the file. */
const SecretName = z.string().regex(/^[A-Z][A-Z0-9_]*$/, {
  message: "must name a stored secret (e.g. INTENZO_USER_1), never contain the value",
});

/**
 * Built-in action denylist (§29). `guardrails.deny_text` adds to it. `guardrails.allow_text` takes
 * built-in terms out, and only where every lane has its own throwaway user or a reset (§21.1).
 */
export const DEFAULT_DENY_TEXT = [
  "delete",
  "remove",
  "cancel subscription",
  "pay",
  "purchase",
  "place order",
  "transfer",
] as const;

export const IntenzoConfig = z
  .strictObject({
    version: z.literal(1),
    preview: z
      .strictObject({
        provider: z.enum(["vercel", "netlify", "localhost"]).default("vercel"),
        /** Case-insensitive prefix of the GitHub deployment environment (§17.1). */
        environment_prefix: z.string().min(1).default("Preview"),
        /** Optional project-name match for monorepos with several deployments. */
        project: z.string().min(1).optional(),
      })
      .prefault({}),
    baseline: z
      .strictObject({
        mode: z.enum(["merge_base", "none"]).default("merge_base"),
        max_drift_commits: z.number().int().min(0).max(50).default(5),
      })
      .prefault({}),
    start: z.strictObject({ default: SameOriginPath.default("/") }).prefault({}),
    isolation: z
      .strictObject({
        session_hook: SameOriginPath.optional(),
        reset_hook: SameOriginPath.optional(),
        users: z
          .array(z.strictObject({ username_secret: SecretName, password_secret: SecretName }))
          .min(1)
          .optional(),
        form_login: z
          .strictObject({
            url: SameOriginPath,
            user_label: z.string().min(1),
            pass_label: z.string().min(1),
          })
          .optional(),
      })
      .prefault({}),
    /** Facts the navigator may use, e.g. "valid discount code: SAVE10". */
    data: z.array(z.string().min(1)).default([]),
    guardrails: z
      .strictObject({
        deny_text: z.array(z.string().min(1)).default([]),
        /** Built-in terms this app's tickets need, e.g. a cart's "Remove" (§29). */
        allow_text: z.array(z.string().min(1)).default([]),
        extra_navigation_origins: z.array(z.url()).default([]),
      })
      .prefault({}),
    judge: z.strictObject({ require_agreement: z.boolean().default(true) }).prefault({}),
    policy: z
      .strictObject({
        run_on: z
          .array(z.enum(["ready_for_review", "preview_ready"]))
          .min(1)
          .default(["ready_for_review", "preview_ready"]),
        /** Note: GitHub treats a neutral check as passing a required check (§22.5). */
        inconclusive_conclusion: z.enum(["neutral", "failure"]).default("neutral"),
        approvers: z.array(z.string().min(1)).default([]),
        agent_handle: z
          .string()
          .regex(/^@[\w-]+$/, { message: "must be a GitHub handle like @intenzo-fixer" })
          .optional(),
        agent_trigger: z.enum(["button", "auto"]).default("button"),
        max_agent_attempts: z.number().int().min(1).max(10).default(3),
        allow_forks: z.boolean().default(false),
      })
      .prefault({}),
    tests: z
      .strictObject({
        export: z.enum(["suggest", "commit", "off"]).default("suggest"),
        dir: z.string().min(1).default("tests/intenzo"),
      })
      .prefault({}),
  })
  .superRefine((config, ctx) => {
    if (config.isolation.form_login && !config.isolation.users) {
      ctx.addIssue({
        code: "custom",
        path: ["isolation", "users"],
        message: "form_login needs a users pool to log in with",
      });
    }
    const builtIn: readonly string[] = DEFAULT_DENY_TEXT;
    config.guardrails.allow_text.forEach((term, i) => {
      if (!builtIn.includes(term.trim().toLowerCase())) {
        ctx.addIssue({
          code: "custom",
          path: ["guardrails", "allow_text", i],
          message: `"${term}" isn't a built-in term (${DEFAULT_DENY_TEXT.join(", ")})`,
        });
      }
    });
    // An allowed "remove" may only ever remove a throwaway user's data (isolationLevel, §21.1).
    const { session_hook, reset_hook, users } = config.isolation;
    const isolated = !!session_hook || (!!reset_hook && !!users?.length);
    if (config.guardrails.allow_text.length > 0 && !isolated) {
      ctx.addIssue({
        code: "custom",
        path: ["guardrails", "allow_text"],
        message: "needs isolation: a session_hook, or a reset_hook with users",
      });
    }
  });
export type IntenzoConfig = z.infer<typeof IntenzoConfig>;
/** The config as written in .intenzo.yml, before defaults. */
export type IntenzoConfigInput = z.input<typeof IntenzoConfig>;
