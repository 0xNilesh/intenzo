import { createHash } from "node:crypto";

import { addUsage, NO_USAGE, type ModelPort, type ModelUsage } from "../models/port.ts";
import {
  INTENT_JSON_SCHEMA,
  INTENT_SYSTEM,
  INTENT_V1,
  IntentReply,
  renderIntent,
  type IntentReplyCriterion,
  type TicketText,
} from "../prompts/intent.v1.ts";
import type { Criterion, CriterionSet } from "../schema/index.ts";

// The intent step (ARCHITECTURE §18) for text tickets: Spark 1.3 reads the ticket (intent.v1),
// and code holds it to the rules a model can't be trusted with:
//   - an explicit checklist maps 1:1 to the criteria, in order (else one retry)
//   - every criterion has a trigger, unless it can't be verified in a browser
//   - "instantly", "immediately" or "right away" without a number → timingMs 1000
//   - ids are C1…Cn in order, and the ticket hash covers the ticket only, never the diff

export const INTENT_MODEL = "muse-spark-1.3";
/** Spark's reply is mostly reasoning tokens, which count toward this. */
const MAX_TOKENS = 12_000;
const INSTANT = /\b(instantly|immediately|right away|at once)\b/i;

export type IntentSource = CriterionSet["intentSource"];

export interface IntentOptions {
  model?: string;
  intentSource?: IntentSource;
  /** Hashes of the ticket's images and videos (§18); they count toward the ticket hash. */
  mediaHashes?: readonly string[];
  /** The PM video's transcript (T4.2). */
  transcript?: string;
  /** The PM video itself, for Spark to watch (T4.2): a data URL from prepareTicketVideo. */
  video?: { dataUrl: string; durationMs?: number };
  timeoutMs?: number;
}

export interface IntentResult {
  ok: boolean;
  intent: CriterionSet;
  /** Rules the reply still broke after the retry, or why the call failed. */
  problems: string[];
  usage: ModelUsage;
  /** Model calls made (0 for an empty ticket, 2 after a retry). */
  calls: number;
}

/** The items of a markdown checklist (`- [ ] …`, `* [x] …`), in order. */
export function checklistItems(text: string): string[] {
  return [...text.matchAll(/^\s*[-*+]\s+\[[ xX]\]\s+(.+?)\s*$/gm)].map((m) => m[1]!);
}

const normalize = (s: string) =>
  s
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trim();

/**
 * §18: sha256 of the normalized ticket text and its media hashes. The diff is never part of it, so
 * a push that only changes code reuses the intent version.
 */
export function ticketHash(ticket: TicketText, mediaHashes: readonly string[] = []): string {
  const canonical = JSON.stringify({
    title: normalize(ticket.title),
    body: normalize(ticket.body),
    comments: ticket.comments.map(normalize),
    media: [...mediaHashes].sort(),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/** Rules the reply breaks, worded for the model's retry. */
function broken(reply: IntentReply, checklist: readonly string[], recording: boolean): string[] {
  const problems: string[] = [];
  if (checklist.length > 0 && reply.criteria.length !== checklist.length) {
    problems.push(
      `The ticket has ${checklist.length} checklist items, but the reply has ${reply.criteria.length} criteria. Write exactly one criterion per item, in this order: ${checklist.map((item, i) => `(${i + 1}) ${item}`).join(" ")}`,
    );
  }
  reply.criteria.forEach((c, i) => {
    if (c.kind !== "not_verifiable_in_ui" && !c.trigger.trim()) {
      problems.push(`Criterion ${i + 1} ("${c.text}") has no trigger: say what to do in the app.`);
    }
    // §18: where it's shown in the video comes only from Spark watching it (no transcript timings).
    if (recording && c.sourceMediaAt === null) {
      problems.push(
        `Criterion ${i + 1} ("${c.text}") has no sourceMediaAt: say when the recording says or shows it, in ms from the start.`,
      );
    }
  });
  return problems;
}

function toCriterion(c: IntentReplyCriterion, i: number): Criterion {
  const instant = [c.text, c.expected, c.sourceQuote ?? ""].some((s) => INSTANT.test(s));
  const timingMs = c.timingMs ?? (instant ? 1000 : null);
  return {
    id: `C${i + 1}`,
    text: c.text,
    trigger: c.trigger,
    setup: c.setup,
    expected: c.expected,
    watch: c.watch,
    kind: c.kind,
    persistence: c.persistence,
    ...(timingMs !== null && { timingMs }),
    inferred: c.inferred,
    ...(c.sourceQuote && { sourceQuote: c.sourceQuote }),
    ...(c.sourceMediaAt !== null && { sourceMediaAt: c.sourceMediaAt }),
  };
}

/** The ticket's criteria (§18), from Spark 1.3, held to the rules above. */
export async function extractIntent(
  port: ModelPort,
  ticket: TicketText,
  options: IntentOptions = {},
): Promise<IntentResult> {
  const hash = ticketHash(ticket, options.mediaHashes);
  const fromVideo = Boolean(options.video || options.transcript);
  const intentSource = options.intentSource ?? (fromVideo ? "linked_issue_video" : "linked_issue");
  const empty = (problems: string[], usage = NO_USAGE, calls = 0): IntentResult => ({
    ok: problems.length === 0,
    intent: { criteria: [], intentSource, ticketHash: hash },
    problems,
    usage,
    calls,
  });
  const text = [ticket.title, ticket.body, ...ticket.comments].join("\n");
  if (!ticket.body.trim() && ticket.comments.length === 0 && !fromVideo) {
    return empty([]); // nothing to read: no call
  }

  const checklist = checklistItems(text);
  const messages = [
    { role: "system" as const, content: INTENT_SYSTEM },
    {
      role: "user" as const,
      content: options.video
        ? [
            {
              type: "text" as const,
              text: renderIntent(ticket, options.transcript, {
                ...(options.video.durationMs && { durationMs: options.video.durationMs }),
              }),
            },
            { type: "video_url" as const, video_url: { url: options.video.dataUrl } },
          ]
        : renderIntent(ticket, options.transcript),
    },
  ];
  let usage = NO_USAGE;
  let reply: IntentReply | undefined;
  let problems: string[] = [];
  let calls = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await port.call({
      stage: "intent",
      model: options.model ?? INTENT_MODEL,
      promptVersion: INTENT_V1,
      messages:
        attempt === 0 || !reply
          ? messages
          : [
              ...messages,
              { role: "assistant" as const, content: JSON.stringify(reply) },
              {
                role: "user" as const,
                content: `${problems.join("\n")}\nReply again with the whole JSON object.`,
              },
            ],
      schema: IntentReply,
      jsonSchema: { name: "intent", schema: INTENT_JSON_SCHEMA },
      maxTokens: MAX_TOKENS,
      ...(options.timeoutMs && { timeoutMs: options.timeoutMs }),
    });
    calls++;
    usage = addUsage(usage, result.usage);
    if (!result.ok) return empty([`the intent call failed: ${result.error}`], usage, calls);
    reply = result.output;
    problems = broken(reply, checklist, Boolean(options.video));
    if (problems.length === 0) break;
  }

  return {
    ok: problems.length === 0,
    intent: {
      criteria: reply!.criteria.map(toCriterion),
      ...((reply!.repro.startPath?.startsWith("/") || reply!.repro.steps.length > 0) && {
        repro: {
          ...(reply!.repro.startPath?.startsWith("/") && { startPath: reply!.repro.startPath }),
          steps: reply!.repro.steps,
        },
      }),
      intentSource,
      ticketHash: hash,
    },
    problems,
    usage,
    calls,
  };
}
