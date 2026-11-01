// IntentBench's results (§31, T6.3): every verdict each arm gave, and every model call behind
// them, as flat lists pandas reads directly (T6.4). One file per split, committed; the pack hashes
// it keeps tie each verdict to the evidence it judged (manifest.json).
import { existsSync, readFileSync } from "node:fs";

import { CriterionId, ReasonCode, VerdictValue } from "@intenzo/core";
import { z } from "zod";

import { ARMS, JUDGE_NAMES, viewsOf } from "./arms.ts";
import { CaseKind } from "./case.ts";

/** Where results go: one file per split, committed. Partial runs (--only) go to raw/, ignored. */
export const RESULTS_DIR = new URL("../../results/", import.meta.url).pathname;

export const JudgeName = z.enum(JUDGE_NAMES);
export const View = z.enum(["dual", ...JUDGE_NAMES]);
/**
 * Core's reason codes (§7), plus two for one judge alone: "decided" when it passed or failed,
 * "unsure" when it said inconclusive itself. (Core calls two unsure judges `judges_disagree`.)
 */
export const BenchReason = z.enum([...ReasonCode.options, "decided", "unsure"]);
export type BenchReason = z.infer<typeof BenchReason>;
/** What was judged: arm A the diff, the others a PR take (pr-2 after §19 e's re-record). */
export const TakeName = z.enum(["diff", "pr-1", "pr-2"]);
export type TakeName = z.infer<typeof TakeName>;

const where = {
  arm: z.enum(ARMS),
  repeat: z.number().int().positive(),
  case: z.string().min(1),
  criterion: CriterionId,
};

/** One model call, with the judge's answer as it gave it and as §22.3 checked it. */
export const BenchCall = z.strictObject({
  ...where,
  take: TakeName,
  judge: JudgeName,
  model: z.string().min(1),
  ok: z.boolean(),
  error: z.string().optional(),
  /** The judge's own verdict; null when it gave no answer. */
  verdict: VerdictValue.nullable(),
  /** After §22.3's checks (arms B–D). Arm A's answer isn't checked: there are no readings. */
  checked: VerdictValue,
  checkedReason: ReasonCode.nullable(),
  targetCorrect: z.boolean().nullable(),
  citedReadings: z.array(z.number().int()).nullable(),
  /** The decisive value: a reading's (B–D), or the code lines arm A copied. */
  citedValue: z.string().nullable(),
  citedFile: z.string().nullable(),
  atMs: z.number().nullable(),
  observed: z.string().nullable(),
  usd: z.number().nonnegative(),
  ms: z.number().nonnegative(),
  promptTokens: z.number().int().nonnegative(),
  cachedTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative(),
});
export type BenchCall = z.infer<typeof BenchCall>;

/** One criterion's verdict, under one arm in one repeat, from one view. */
export const BenchVerdict = z.strictObject({
  ...where,
  view: View,
  kind: CaseKind,
  /** The ground truth (T6.1). */
  label: z.enum(["pass", "fail"]),
  /** How exploring went (T6.2): a pack that found no path has no takes to judge. */
  explore: z.enum(["found", "setup_failed", "trigger_absent"]),
  verdict: VerdictValue,
  reason: BenchReason,
  /** The take the verdict rests on; null when nothing was judged. */
  take: TakeName.nullable(),
  /** The calls this view needed. A take's calls run at once, so `ms` counts the slower. */
  calls: z.number().int().nonnegative(),
  usd: z.number().nonnegative(),
  ms: z.number().nonnegative(),
});
export type BenchVerdict = z.infer<typeof BenchVerdict>;

export const itemKey = (v: { arm: string; repeat: number; case: string; criterion: string }) =>
  `${v.arm} ${v.repeat} ${v.case} ${v.criterion}`;

export const BenchResults = z
  .strictObject({
    version: z.literal(1),
    split: z.enum(["tuning", "heldout"]),
    /** What each arm judged sent: its prompt version, and the media. */
    prompts: z.partialRecord(z.enum(ARMS), z.string()),
    models: z.partialRecord(JudgeName, z.string()),
    startedAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    /** The packs judged, "case/criterion" → sha256, as manifest.json has them. */
    packs: z.record(z.string(), z.string()),
    verdicts: z.array(BenchVerdict),
    calls: z.array(BenchCall),
  })
  .superRefine((r, ctx) => {
    const seen = new Set<string>();
    for (const v of r.verdicts) {
      const key = `${itemKey(v)} ${v.view}`;
      if (seen.has(key)) ctx.addIssue({ code: "custom", message: `${key} is there twice` });
      seen.add(key);
      if (!viewsOf(v.arm).includes(v.view))
        ctx.addIssue({ code: "custom", message: `arm ${v.arm} has no ${v.view} view` });
      if (!r.packs[`${v.case}/${v.criterion}`])
        ctx.addIssue({ code: "custom", message: `${v.case}/${v.criterion} has no pack hash` });
    }
  });
export type BenchResults = z.infer<typeof BenchResults>;

export function readResults(file: string): BenchResults | null {
  return existsSync(file) ? BenchResults.parse(JSON.parse(readFileSync(file, "utf8"))) : null;
}

/**
 * The results of an earlier run that still stand: rows of packs recorded again since (their
 * hash changed) are dropped, so they're judged again.
 */
export function stillCurrent(r: BenchResults, packs: Readonly<Record<string, string>>) {
  const same = (v: { case: string; criterion: string }) => {
    const pack = `${v.case}/${v.criterion}`;
    return r.packs[pack] !== undefined && r.packs[pack] === packs[pack];
  };
  return { ...r, verdicts: r.verdicts.filter(same), calls: r.calls.filter(same) };
}

/** One row per line, so a rerun's diff shows the rows it added. */
export function formatResults(r: BenchResults): string {
  const rows = (list: readonly object[]) =>
    list.length === 0 ? "[]" : `[\n${list.map((x) => `    ${JSON.stringify(x)}`).join(",\n")}\n  ]`;
  const { verdicts, calls, ...head } = r;
  const top = Object.entries(head).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  return `{\n${[...top, `  "verdicts": ${rows(verdicts)}`, `  "calls": ${rows(calls)}`].join(",\n")}\n}\n`;
}
