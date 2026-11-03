// The context bundle (ARCHITECTURE §8): what the worker needs to know about the PR and its tickets,
// gathered by the Cloud, the only code with GitHub credentials (§29), when a run's job is spawned.
// The PR, the tickets its description names (§17.2: several with an Intent section), each with
// the PM's recording, the PR's own criteria and test hints, and the diff (patches cut at 400
// lines). The
// recording and the bundle go to the private Blob store, and the worker gets signed GET URLs for
// both, valid for the job (§28): it never holds a GitHub or Blob credential.
import { createHash } from "node:crypto";

import { type ArtifactRef, ContextBundle } from "@intenzo/core";
import {
  combinedHash,
  parsePrIntent,
  prCriteriaTicket,
  PR_SOURCE,
  ticketHash,
  videoUrlsIn,
} from "@intenzo/core/intent";
import { z } from "zod";

import { FULL_JSON, type GitHub } from "../github/api.ts";

const MAX_PATCH_LINES = 400;
const MAX_COMMENTS = 20;
const MAX_FILES = 100;
/** Recordings read per run: each is transcribed and watched, so they're the costly part (§18). */
const MAX_VIDEOS = 2;

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
  /** The intent's hash over its tickets and the PR's criteria (§18); null without either. */
  ticketHash: string | null;
  /** GitHub says the PR's repo is public: its evidence may go to the public store (§28). */
  repoPublic: boolean;
}

// docs.github.com/en/rest/pulls/pulls#get-a-pull-request and #list-pull-requests-files;
// docs.github.com/en/rest/issues/issues#get-an-issue (full+json adds body_html).
const Pull = z.looseObject({
  title: z.string(),
  body: z.string().nullable(),
  head: z.looseObject({ sha: z.string() }),
  base: z.looseObject({
    ref: z.string(),
    repo: z.looseObject({ private: z.boolean() }).nullish(),
  }),
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

  const intent = parsePrIntent(pr.title, pr.body, { self: prNumber, repo });
  const tickets: ContextBundle["tickets"] = [];
  const parts: { source: string; hash: string }[] = [];
  const media: ArtifactRef[] = [];
  const mediaUrls: string[] = [];
  let mediaUnavailable = false;
  for (const n of intent.tickets) {
    const issue = await github.get(`/repos/${repo}/issues/${n}`, Issue, FULL_JSON);
    if (!issue || issue.pull_request) continue;
    const comments =
      (await github.get(
        `/repos/${repo}/issues/${n}/comments?per_page=${MAX_COMMENTS}`,
        Comments,
      )) ?? [];
    const text = {
      ref: `#${n}`,
      title: issue.title,
      body: issue.body ?? "",
      comments: comments.flatMap((c) => (c.body?.trim() ? [c.body] : [])),
    };
    // §18: the PM's recording, one per ticket, at most MAX_VIDEOS per run.
    let video: number | null = null;
    const mediaHashes: string[] = [];
    const [url] = videoUrlsIn(issue.body_html ?? "");
    if (url && media.length < MAX_VIDEOS) {
      const bytes = await github.download(url);
      const ref =
        bytes &&
        (await deps.put(`runs/${runId}/ticket/media-${media.length + 1}.mp4`, bytes, "video/mp4"));
      const signed = ref && (await deps.sign(ref));
      if (bytes && ref && signed) {
        video = media.length;
        media.push(ref);
        mediaUrls.push(signed);
        mediaHashes.push(sha256(bytes));
      } else {
        mediaUnavailable = true;
        log(`PR #${prNumber}: ticket #${n}'s recording couldn't be downloaded`);
      }
    } else if (url) {
      log(
        `PR #${prNumber}: ticket #${n}'s recording is past ${MAX_VIDEOS} a run, so its text is read alone`,
      );
    }
    tickets.push({ ...text, video });
    parts.push({ source: text.ref, hash: ticketHash(text, mediaHashes) });
  }
  if (intent.criteria.length > 0) {
    parts.push({
      source: PR_SOURCE,
      hash: ticketHash(prCriteriaTicket(pr.title, intent.criteria)),
    });
  }
  const first = tickets[0];
  const ticket: ContextBundle["ticket"] = first
    ? {
        source: "github_issue",
        ref: first.ref,
        title: first.title,
        body: first.body,
        comments: first.comments,
      }
    : null;
  const hints =
    intent.hints.start || intent.hints.data.length > 0
      ? { ...(intent.hints.start && { start: intent.hints.start }), data: intent.hints.data }
      : null;

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
    tickets,
    prCriteria: intent.criteria,
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
    hints,
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
    ticketHash: parts.length > 0 ? combinedHash(parts) : null,
    // Only an explicit "not private": a reply without the field keeps the evidence private.
    repoPublic: pr.base.repo?.private === false,
  };
}
