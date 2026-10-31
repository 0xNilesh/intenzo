import { z } from "zod";

import { ArtifactRef } from "./artifact.ts";
import { IntenzoConfig } from "./config.ts";
import { CriterionId, CriterionSet } from "./criterion.ts";
import { SavedPath } from "./navigation.ts";

const Sha = z
  .string()
  .regex(/^[0-9a-f]{40}$/, { message: "must be a full 40-character commit sha" });

/** The optional `<!-- intenzo … -->` block in a ticket or PR body. */
export const IntenzoHints = z.object({
  start: z.string().startsWith("/").optional(),
  data: z.array(z.string()).default([]),
});
export type IntenzoHints = z.infer<typeof IntenzoHints>;

/** Everything the worker needs to know about the PR and its ticket, gathered by Cloud (§8). */
export const ContextBundle = z.object({
  pr: z.object({
    number: z.number().int().positive(),
    title: z.string(),
    body: z.string(),
    headSha: Sha,
    baseRef: z.string().min(1),
    isFork: z.boolean(),
    isBot: z.boolean(),
  }),
  ticket: z
    .object({
      source: z.enum(["github_issue", "none"]),
      ref: z.string(),
      title: z.string(),
      body: z.string(),
      comments: z.array(z.string()),
    })
    .nullable(),
  images: z.array(ArtifactRef),
  media: z.array(ArtifactRef),
  /** Signed GET URLs for `media`, in order, valid for the job: the worker holds no Blob key (§28). */
  mediaUrls: z.array(z.url()).default([]),
  /** True when the ticket had media Cloud couldn't download; the report says so (§8). */
  mediaUnavailable: z.boolean().default(false),
  diff: z.object({
    files: z.array(
      z.object({
        path: z.string().min(1),
        status: z.enum([
          "added",
          "removed",
          "modified",
          "renamed",
          "copied",
          "changed",
          "unchanged",
        ]),
        additions: z.number().int().nonnegative(),
        deletions: z.number().int().nonnegative(),
        /** Truncated to 400 lines; absent for binary files. */
        patch: z.string().optional(),
      }),
    ),
  }),
  hints: IntenzoHints.nullable(),
});
export type ContextBundle = z.infer<typeof ContextBundle>;

const JobBase = z.object({
  jobId: z.uuid(),
  runId: z.uuid(),
  deadlineAt: z.iso.datetime(),
  /** HMAC JWT scoped to this job; exp = deadline + 5 min, refreshed via /alive (§8). */
  callback: z.object({ baseUrl: z.url(), token: z.string().min(1) }),
  config: IntenzoConfig,
});

/** The one job type (§8): intent at step 0 when not reused, then verification. */
export const VerifyJob = JobBase.extend({
  type: z.literal("verify"),
  /**
   * A signed URL of the ContextBundle in the private store. Null until the Cloud builds bundles
   * (P4): the stub worker of T2.7b reads no ticket and no diff.
   */
  bundleUrl: z.url().nullable(),
  /** The reused intent for this ticketHash, or null to compute it at step 0. */
  intent: CriterionSet.nullable(),
  prUrl: z.url(),
  /** The merge-base preview; null means no baseline. */
  baseUrl: z.url().nullable(),
  baseSha: Sha.nullable(),
  /** Decrypted just in time and never logged. Null for fork PRs: no secrets reach their code. */
  secrets: z
    .object({
      bypass: z.string().optional(),
      hookSecret: z.string().optional(),
      users: z.array(z.object({ username: z.string(), password: z.string() })).optional(),
    })
    .nullable(),
  cachedPaths: z.array(SavedPath),
  /** Re-run only these criteria ("/intenzo rerun C2"). */
  only: z.array(CriterionId).optional(),
});
export type VerifyJob = z.infer<typeof VerifyJob>;
