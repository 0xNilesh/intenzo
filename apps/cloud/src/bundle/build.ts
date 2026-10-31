// The context bundle (ARCHITECTURE §8): what the worker needs to know about the PR and its ticket,
// gathered by the Cloud, the only code with GitHub credentials (§29), when a run's job is spawned.
// The PR, its ticket (§17.2) with the PM's recording, and the diff (patches cut at 400 lines). The
// recording and the bundle go to the private Blob store, and the worker gets signed GET URLs for
// both, valid for the job (§28): it never holds a GitHub or Blob credential.
import { createHash } from "node:crypto";

import { type ArtifactRef, ContextBundle } from "@intenzo/core";
import { ticketHash, ticketNumberOf, videoUrlsIn } from "@intenzo/core/intent";
import { z } from "zod";

import { FULL_JSON, type GitHub } from "../github/api.ts";

const MAX_PATCH_LINES = 400;
const MAX_COMMENTS = 20;
const MAX_FILES = 100;

export interface BundleDeps {
  github: GitHub;
  /** Stores a file in the private Blob store, overwriting a respawned job's copy. */
  put: (path: string, body: Uint8Array | string, contentType: string) => Promise<ArtifactRef>;
  /** A signed GET URL for a stored file, or null when the store isn't configured. */
  sign: (ref: ArtifactRef) => Promise<string | null>;
  log: (line: string) => void;
}

export interface BundleTarget {
  repo: string;
  prNumber: number;
  runId: string;
  isFork: boolean;
}

export interface BuiltBundle {
  bundle: ContextBundle;
  bundleUrl: string;
  /** The ticket's hash (§18), to reuse its intent version; null without a ticket. */
  ticketHash: string | null;
}

// docs.github.com/en/rest/pulls/pulls#get-a-pull-request and #list-pull-requests-files;
// docs.github.com/en/rest/issues/issues#get-an-issue (full+json adds body_html).
const Pull = z.looseObject({
  title: z.string(),
  body: z.string().nullable(),
  head: z.looseObject({ sha: z.string() }),
  base: z.looseObject({ ref: z.string() }),
  user: z.looseObject({ type: z.string() }).nullable(),
});
const Issue = z.looseObject({
  title: z.string(),
  body: z.string().nullable(),
  body_html: z.string().nullish(),
  pull_request: z.unknown().optional(),
});
const Comments = z.array(z.looseObject({ body: z.string().nullable() }));
const Files = z.array(
  z.looseObject({
    filename: z.string(),
    status: ContextBundle.shape.diff.shape.files.element.shape.status,
    additions: z.number(),
    deletions: z.number(),
    patch: z.string().optional(),
  }),
);

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export async function buildBundle(deps: BundleDeps, target: BundleTarget): Promise<BuiltBundle> {
  const { github, log } = deps;
  const { repo, prNumber, runId } = target;
  const pr = await github.get(`/repos/${repo}/pulls/${prNumber}`, Pull);
  if (!pr) throw new Error(`no PR #${prNumber} in ${repo}`);

  let ticket: ContextBundle["ticket"] = null;
  const media: ArtifactRef[] = [];
  const mediaUrls: string[] = [];
  const mediaHashes: string[] = [];
  let mediaUnavailable = false;
  const n = ticketNumberOf(pr.title, pr.body);
  const issue =
    n !== null && n !== prNumber
      ? await github.get(`/repos/${repo}/issues/${n}`, Issue, FULL_JSON)
      : null;
  if (issue && !issue.pull_request) {
    const comments =
      (await github.get(
        `/repos/${repo}/issues/${n}/comments?per_page=${MAX_COMMENTS}`,
        Comments,
      )) ?? [];
    ticket = {
      source: "github_issue",
      ref: `#${n}`,
      title: issue.title,
      body: issue.body ?? "",
      comments: comments.flatMap((c) => (c.body?.trim() ? [c.body] : [])),
    };
    // §18: the PM's recording. One is enough for the demo's tickets; more would need a budget.
    const [video] = videoUrlsIn(issue.body_html ?? "");
    if (video) {
      const bytes = await github.download(video);
      const ref = bytes && (await deps.put(`runs/${runId}/ticket/media-1.mp4`, bytes, "video/mp4"));
      const url = ref && (await deps.sign(ref));
      if (bytes && ref && url) {
        media.push(ref);
        mediaUrls.push(url);
        mediaHashes.push(sha256(bytes));
      } else {
        mediaUnavailable = true;
        log(`PR #${prNumber}: ticket #${n}'s recording couldn't be downloaded`);
      }
    }
  }

  const files =
    (await github.get(`/repos/${repo}/pulls/${prNumber}/files?per_page=${MAX_FILES}`, Files)) ?? [];
  const bundle = ContextBundle.parse({
    pr: {
      number: prNumber,
      title: pr.title,
      body: pr.body ?? "",
      headSha: pr.head.sha,
      baseRef: pr.base.ref,
      isFork: target.isFork,
      isBot: pr.user?.type === "Bot",
    },
    ticket,
    images: [],
    media,
    mediaUrls,
    mediaUnavailable,
    diff: {
      files: files.map((f) => ({
        path: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        ...(f.patch !== undefined && {
          patch: f.patch.split("\n").slice(0, MAX_PATCH_LINES).join("\n"),
        }),
      })),
    },
    hints: null,
  });
  const stored = await deps.put(
    `runs/${runId}/bundle.json`,
    JSON.stringify(bundle),
    "application/json",
  );
  const bundleUrl = await deps.sign(stored);
  if (!bundleUrl) throw new Error("the private Blob store isn't configured: no bundle");
  return {
    bundle,
    bundleUrl,
    ticketHash: ticket
      ? ticketHash(
          { ref: ticket.ref, title: ticket.title, body: ticket.body, comments: ticket.comments },
          mediaHashes,
        )
      : null,
  };
}
