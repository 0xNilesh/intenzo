import { costUsd } from "../models/pricing.ts";
import type { ModelPort } from "../models/port.ts";
import {
  CHANGES_JSON_SCHEMA,
  CHANGES_SYSTEM,
  CHANGES_V1,
  ChangesReply,
  renderChanges,
} from "../prompts/changes.v1.ts";
import type { UnrequestedChange } from "../schema/events.ts";
import { describeHunk, type Hunk } from "./diff.ts";

// §24: Spark 1.3 says which hunks the criteria explain; the rest, when it's sure enough, are the
// report's unrequested changes.

export const CHANGES_MODEL = "muse-spark-1.3";
/** §24: report a change only when the model is this sure no criterion explains it. */
export const MIN_CONFIDENCE = 0.7;
/** §24: at most this many in the report. */
export const MAX_REPORTED = 3;

export async function classifyChanges(
  port: ModelPort,
  input: {
    route: string;
    criteria: readonly { id: string; text: string; expected: string }[];
    hunks: readonly Hunk[];
  },
): Promise<{ changes: UnrequestedChange[]; costUsd: number; error: string | null }> {
  if (input.hunks.length === 0) return { changes: [], costUsd: 0, error: null };
  const result = await port.call({
    stage: "changes",
    model: CHANGES_MODEL,
    promptVersion: CHANGES_V1,
    messages: [
      { role: "system", content: CHANGES_SYSTEM },
      {
        role: "user",
        content: renderChanges(
          input.criteria,
          input.route,
          input.hunks.map((h) => ({
            id: h.id,
            landmark: h.landmark,
            removed: h.removed.map((l) => l.text),
            added: h.added.map((l) => l.text),
          })),
        ),
      },
    ],
    schema: ChangesReply,
    jsonSchema: { name: "changes", schema: CHANGES_JSON_SCHEMA },
    reasoningEffort: "low",
    timeoutMs: 60_000,
  });
  const spent = costUsd(CHANGES_MODEL, result.usage) ?? 0;
  if (!result.ok) return { changes: [], costUsd: spent, error: result.error };
  const changes = input.hunks.flatMap((hunk) => {
    const verdict = result.output.hunks.find((h) => h.id === hunk.id);
    return verdict && verdict.explainedBy === null && verdict.confidence >= MIN_CONFIDENCE
      ? // Written by code from the hunk, not by the model: `link "Checkout" → "Continue"`.
        [{ route: input.route, description: describeHunk(hunk), confidence: verdict.confidence }]
      : [];
  });
  return { changes, costUsd: spent, error: null };
}

/** §24: the most certain few, for the report. */
export function reportable(changes: readonly UnrequestedChange[]): UnrequestedChange[] {
  return [...changes].sort((a, b) => b.confidence - a.confidence).slice(0, MAX_REPORTED);
}
