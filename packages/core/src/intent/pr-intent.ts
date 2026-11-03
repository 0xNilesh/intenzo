import { createHash } from "node:crypto";

import type { TicketText } from "../prompts/intent.v1.ts";
import type { ContextBundle, Criterion, CriterionSet } from "../schema/index.ts";
import { ticketNumberOf } from "./ticket.ts";

// A PR's intent (ARCHITECTURE §17.2, multiple intents): the description says which tickets the PR
// delivers, and may add checks of its own and hints for the navigator.
//
//   ## Intent                    one ticket per line: Closes #5, Fixes #7, an issue URL…
//   ## Acceptance criteria       optional bullets: checks the PR claims (shown as unverified)
//   ## Test hints                optional: "start: /cart", "data: valid code: SAVE10"
//
// Without an "Intent" section the old rule applies: the first "Closes #N" in the title or
// description. The tickets stay the authority: a PR's own criteria are reported apart and never
// count toward the run's outcome or the PM's approval.

export const MAX_TICKETS = 5;
export const MAX_PR_CRITERIA = 10;
/** A run's criteria across all its sources: the tickets' first, then the PR's. */
export const MAX_RUN_CRITERIA = 12;
const MAX_CRITERION_CHARS = 300;
/** The `source` of criteria the PR declares itself. */
export const PR_SOURCE = "pr";

export interface PrIntent {
  /** Issue numbers the PR delivers, in order, without duplicates. */
  tickets: number[];
  /** Acceptance criteria the PR declares itself (unverified). */
  criteria: string[];
  hints: { start?: string; data: string[] };
  /** True when the description has an "Intent" section; else the single-ticket rule was used. */
  structured: boolean;
}

/** "acceptance criteria" → its lines, for each `##`/`###` section of the description. */
function sections(body: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of body.split(/\r?\n/)) {
    const heading = /^\s{0,3}#{2,3}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      const name = heading[1]!
        .toLowerCase()
        .replace(/[^a-z ]/g, "")
        .trim();
      current = found.get(name) ?? [];
      found.set(name, current);
    } else if (current) {
      current.push(line);
    }
  }
  return found;
}

const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.+?)\s*$/;

/** The issue a line of the Intent section names, if any (same repo when `repo` is given). */
function ticketIn(line: string, repo?: string): number | null {
  const url = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)\b/i.exec(line);
  if (url) return !repo || url[1]!.toLowerCase() === repo.toLowerCase() ? Number(url[2]) : null;
  const other = /\b([\w.-]+\/[\w.-]+)#(\d+)\b/.exec(line);
  if (other)
    return !repo || other[1]!.toLowerCase() === repo.toLowerCase() ? Number(other[2]) : null;
  const local = /(?<![\w/&])#(\d+)\b/.exec(line);
  return local ? Number(local[1]) : null;
}

export function parsePrIntent(
  title: string,
  body: string | null,
  options: { self?: number; repo?: string } = {},
): PrIntent {
  // Template comments (<!-- … -->) are instructions to the author, never content.
  const text = (body ?? "").replace(/<!--[\s\S]*?-->/g, "");
  const found = sections(text);
  const keep = (n: number | null): n is number => n !== null && n !== options.self;

  const intent = found.get("intent");
  let tickets: number[];
  if (intent) {
    tickets = [];
    for (const line of intent) {
      const n = ticketIn(line, options.repo);
      if (keep(n) && !tickets.includes(n)) tickets.push(n);
    }
    tickets = tickets.slice(0, MAX_TICKETS);
  } else {
    const n = ticketNumberOf(title, text);
    tickets = keep(n) ? [n] : [];
  }

  const criteria = (found.get("acceptance criteria") ?? [])
    .map((line) => BULLET.exec(line)?.[1])
    .filter((c): c is string => Boolean(c))
    .map((c) => c.slice(0, MAX_CRITERION_CHARS))
    .slice(0, MAX_PR_CRITERIA);

  const hints: PrIntent["hints"] = { data: [] };
  for (const raw of found.get("test hints") ?? []) {
    const line = raw.replace(/^\s*(?:[-*+]\s+)?/, "");
    const start = /^start:\s*(\S+)\s*$/i.exec(line)?.[1];
    if (start && start.startsWith("/") && !start.startsWith("//")) hints.start = start;
    const data = /^data:\s*(.+?)\s*$/i.exec(line)?.[1];
    if (data) hints.data.push(data);
  }

  return { tickets, criteria, hints, structured: Boolean(intent) };
}

/** One source of a run's intent: a ticket ("#5") or the PR's own criteria ("pr"). */
export interface IntentPart {
  source: string;
  set: CriterionSet;
}

/**
 * The run's criteria from all its sources: in order, renumbered C1…Cn, each tagged with its
 * source, at most MAX_RUN_CRITERIA (tickets first, so the PR's own are the ones cut). The hash
 * covers every source, so the intent is reused only for the same tickets and the same PR checks.
 */
export function mergeIntents(parts: readonly IntentPart[]): CriterionSet {
  const tagged: Criterion[] = parts.flatMap((p) =>
    p.set.criteria.map((c) => ({ ...c, source: p.source })),
  );
  const criteria = tagged.slice(0, MAX_RUN_CRITERIA).map((c, i) => ({ ...c, id: `C${i + 1}` }));
  const tickets = parts.filter((p) => p.source !== PR_SOURCE);
  const intentSource = tickets.some((p) => p.set.intentSource === "linked_issue_video")
    ? "linked_issue_video"
    : tickets.length > 0
      ? "linked_issue"
      : "pr_body";
  const repro = parts.find((p) => p.set.repro)?.set.repro;
  const ticketHash = combinedHash(parts.map((p) => ({ source: p.source, hash: p.set.ticketHash })));
  return { criteria, ...(repro && { repro }), intentSource, ticketHash };
}

/** Criteria the run's outcome and the PM's approval count: the tickets', never the PR's own. */
export const countsTowardOutcome = (c: Pick<Criterion, "source">): boolean =>
  c.source !== PR_SOURCE;

/**
 * The intent's hash over its sources, the same in the Cloud (to reuse an intent version) and the
 * worker (mergeIntents): one source keeps its own hash.
 */
export function combinedHash(parts: readonly { source: string; hash: string }[]): string {
  if (parts.length === 1) return parts[0]!.hash;
  return createHash("sha256")
    .update(JSON.stringify(parts.map((p) => [p.source, p.hash])))
    .digest("hex");
}

/** The PR's own criteria as a checklist ticket, so intent.v1 keeps them 1:1, in order. */
export function prCriteriaTicket(prTitle: string, criteria: readonly string[]): TicketText {
  return {
    ref: "PR",
    title: prTitle,
    body: ["## Acceptance criteria", ...criteria.map((c) => `- [ ] ${c}`)].join("\n"),
    comments: [],
  };
}

export interface IntentSourceText {
  /** "#5", "pr", or "PR body" for a PR with neither tickets nor criteria of its own. */
  source: string;
  ticket: TicketText;
  /** The ticket's recording (a signed URL from the bundle), if it has one. */
  videoUrl?: string;
  intentSource: CriterionSet["intentSource"];
}

/**
 * What the intent step reads, in order: each linked ticket (with its own recording), then the
 * PR's own criteria. A PR with neither falls back to its description (§17.2 step 3).
 */
export function intentSources(bundle: ContextBundle): IntentSourceText[] {
  const tickets =
    bundle.tickets.length > 0
      ? bundle.tickets
      : bundle.ticket
        ? [{ ...bundle.ticket, video: bundle.mediaUrls.length > 0 ? 0 : null }]
        : [];
  const sources: IntentSourceText[] = tickets.map((t) => {
    const videoUrl = t.video === null ? undefined : bundle.mediaUrls[t.video];
    return {
      source: t.ref,
      ticket: { ref: t.ref, title: t.title, body: t.body, comments: t.comments },
      ...(videoUrl && { videoUrl }),
      intentSource: "linked_issue",
    };
  });
  if (bundle.prCriteria.length > 0) {
    sources.push({
      source: PR_SOURCE,
      ticket: prCriteriaTicket(bundle.pr.title, bundle.prCriteria),
      intentSource: "pr_body",
    });
  }
  if (sources.length === 0) {
    sources.push({
      source: "PR body",
      ticket: { ref: "PR body", title: bundle.pr.title, body: bundle.pr.body, comments: [] },
      intentSource: "pr_body",
    });
  }
  return sources;
}
