// IntentBench's "judge many" (§31, T6.3): each arm judges each criterion of the chosen cases from
// its pack, as many times as asked. Every verdict follows the worker's rules: §22.1 before any
// judge looks, §22.3's checks on each answer, and §19 e on the pack's two PR takes, where a fail or
// a tie on the first is judged once more on the second. D asks both judges; its dual verdict and
// each judge's alone come from the same calls, and a judge is asked again only when a view needs it.
import { join } from "node:path";

import type { Criterion, JudgeOutput, LaneResult, VerdictValue } from "@intenzo/core";
import {
  afterRerecord,
  capVerdict,
  type Checked,
  checkJudge,
  combine,
  type Combined,
  type Judge,
  judgeRequest,
  preJudge,
  rerecordFor,
} from "@intenzo/core/judge";
import { costUsd, type ModelResult } from "@intenzo/core/models";

import {
  ARM_JUDGES,
  type Arm,
  armParts,
  type ArmSide,
  type JudgeName,
  sideOf,
  type View,
  viewsOf,
} from "./arms.ts";
import type { BenchCase, Ticket } from "./case.ts";
import { stillsOf } from "./frames.ts";
import type { BenchDiff } from "./github.ts";
import { type Pack, packDir, type Take } from "./pack.ts";
import { type BenchCall, type BenchReason, type BenchVerdict, itemKey } from "./results.ts";
import { reviewMessages, type ReviewReply, reviewRequest } from "./review.ts";

/** A criterion of a case, with all the arms need to judge it. */
export interface BenchItem {
  case: BenchCase;
  criterion: Criterion;
  ticket: Ticket;
  pack: Pack;
  /** The case's diff (T6.2), for arm A. */
  diff: BenchDiff;
}

export interface JudgeOptions {
  /** The packs folder. */
  dir: string;
  /** Where arm C's stills are cut, once per take. */
  stillsDir: string;
  judges: Partial<Record<JudgeName, Judge>>;
  arms: readonly Arm[];
  repeats: number;
  /** Items judged by an earlier run (itemKey): skipped. */
  done?: ReadonlySet<string>;
  log: (line: string) => void;
  /** Replaces every secret in a text before it's logged or kept. */
  redact?: (text: string) => string;
  /** Criteria judged at once. */
  concurrency?: number;
  /** No new criterion starts once the calls cost this much, or Spark Open's this much (USD). */
  maxUsd?: number;
  maxOpenUsd?: number;
  /** Gets each criterion's verdicts and calls as soon as it's judged, to keep them. */
  onJudged?: (judging: Judging) => void;
  /** Cuts a judge video's stills (tests leave ffmpeg out). */
  stills?: (video: string, dir: string) => string[];
}

export interface Judging {
  verdicts: BenchVerdict[];
  calls: BenchCall[];
}

export interface JudgeSummary {
  judged: number;
  /** Criteria that crashed: no verdict, so a rerun judges them. */
  crashed: string[];
  /** Why no more criteria were started, if the run stopped early. */
  stopped: string | null;
  /** Criteria not started. */
  left: number;
  usd: number;
  openUsd: number;
}

type Outcome = { verdict: VerdictValue; reason: BenchReason };

/** One judge's verdict as if it judged alone: its own inconclusive, or its verdict under §22.1. */
export function alone(checked: Checked, lane: LaneResult | null): Outcome {
  if (checked.verdict === "inconclusive") {
    return { verdict: "inconclusive", reason: checked.reason ?? "unsure" };
  }
  const own: Combined = { verdict: checked.verdict, reason: "agreed" };
  const capped = lane ? capVerdict(own, lane) : own;
  return capped.reason === "agreed" ? { verdict: capped.verdict, reason: "decided" } : capped;
}

/** §19 e for one judge: its fail is judged again on the second take, and stands only if repeated. */
export const confirmed = (second: Outcome): Outcome =>
  second.verdict === "fail" ? second : { verdict: "inconclusive", reason: "flaky" };

interface Answer {
  checked: Checked;
  call: BenchCall;
}
/** One take judged: decided by §22.1 before any judge looked, or each asked judge's answer. */
interface Round {
  pre: Combined | null;
  answers: Partial<Record<JudgeName, Answer>>;
}

const usd = (n: number) => Math.round(n * 1e6) / 1e6;
const cut = (text: string | null | undefined, redact: (t: string) => string, max = 600) =>
  text === null || text === undefined ? null : redact(text).slice(0, max);

/** One criterion, under one arm, in one repeat. */
export async function judgeItem(
  arm: Arm,
  repeat: number,
  item: BenchItem,
  options: Pick<JudgeOptions, "dir" | "stillsDir" | "judges" | "redact" | "stills">,
): Promise<Judging> {
  const redact = options.redact ?? ((text: string) => text);
  const where = { arm, repeat, case: item.case.id, criterion: item.criterion.id };
  const row = {
    ...where,
    kind: item.case.kind,
    label: item.case.labels[item.criterion.id]!,
    explore: item.pack.explore.status,
  };
  const judgeOf = (name: JudgeName): Judge => {
    const judge = options.judges[name];
    if (!judge) throw new Error(`arm ${arm} needs ${name}, which has no key`);
    return judge;
  };
  const record = (
    take: BenchCall["take"],
    judge: Judge,
    r: ModelResult<unknown>,
    checked: Checked,
    answer: Partial<BenchCall>,
  ): BenchCall => ({
    ...where,
    take,
    judge: judge.name as JudgeName,
    model: judge.model,
    ok: r.ok,
    ...(!r.ok && { error: cut(r.error, redact, 300)! }),
    verdict: null,
    targetCorrect: null,
    citedReadings: null,
    citedValue: null,
    citedFile: null,
    atMs: null,
    observed: null,
    ...answer,
    checked: checked.verdict,
    checkedReason: checked.reason,
    usd: usd(costUsd(judge.model, r.usage) ?? 0),
    ms: Math.round(r.ms),
    promptTokens: r.usage.promptTokens,
    cachedTokens: r.usage.cachedTokens,
    completionTokens: r.usage.completionTokens,
    reasoningTokens: r.usage.reasoningTokens,
  });

  if (arm === "A") {
    const judge = judgeOf("Spark 1.3");
    const messages = reviewMessages(item.ticket.text, item.diff.files, item.criterion);
    const r = await judge.port.call(reviewRequest(judge, messages));
    const output: ReviewReply | null = r.ok ? r.output : null;
    const checked: Checked = output
      ? { verdict: output.verdict, reason: null }
      : { verdict: "inconclusive", reason: "infra_error" };
    const call = record("diff", judge, r, checked, {
      verdict: output?.verdict ?? null,
      citedFile: cut(output?.citedFile, redact),
      citedValue: cut(output?.citedCode, redact),
      observed: cut(output?.observed, redact),
    });
    const outcome = alone(checked, null);
    const verdict = { ...row, view: "Spark 1.3" as const, ...outcome, take: "diff" as const };
    return { calls: [call], verdicts: [{ ...verdict, calls: 1, usd: call.usd, ms: call.ms }] };
  }

  const views = viewsOf(arm);
  const takes = item.pack.takes;
  if (!takes) {
    // The navigator found no way to the trigger, so nothing was recorded (§19, T3.5).
    const reason =
      item.pack.explore.status === "trigger_absent" ? "precondition_unmet" : "setup_failed";
    return {
      calls: [],
      verdicts: views.map((view) => ({
        ...row,
        view,
        verdict: "inconclusive",
        reason,
        take: null,
        calls: 0,
        usd: 0,
        ms: 0,
      })),
    };
  }
  const folder = packDir(options.dir, item.case.id, item.criterion.id);
  const stills = options.stills ?? stillsOf;
  const side = (name: "pr-1" | "pr-2" | "base", take: Take): ArmSide => {
    const s = sideOf(join(folder, name), take);
    if (arm !== "C" || !s.judgeVideo) return s;
    const at = join(options.stillsDir, item.case.id, item.criterion.id, name);
    return { ...s, stills: stills(s.judgeVideo, at) };
  };
  const sides = { "pr-1": side("pr-1", takes.pr[0]), "pr-2": side("pr-2", takes.pr[1]) };
  const base = side("base", takes.base);

  const names = ARM_JUDGES[arm];
  const ask = async (take: "pr-1" | "pr-2", who: readonly JudgeName[]): Promise<Round> => {
    const pr = sides[take];
    const pre = preJudge(item.criterion, pr.lane);
    if (pre) return { pre, answers: {} };
    const parts = armParts(arm, item.criterion, pr, base);
    const answered = await Promise.all(
      who.map(async (name) => {
        const judge = judgeOf(name);
        const r = await judge.port.call(judgeRequest(judge, parts));
        const output: JudgeOutput | null = r.ok ? r.output : null;
        const checked = checkJudge(output, item.criterion, pr.lane.readings);
        const call = record(take, judge, r, checked, {
          verdict: output?.verdict ?? null,
          targetCorrect: output?.targetCorrect ?? null,
          citedReadings: output?.citedReadings ?? null,
          citedValue: cut(output?.citedValue, redact),
          atMs: output?.atMs ?? null,
          observed: cut(output?.observed, redact),
        });
        return [name, { checked, call }] as const;
      }),
    );
    return { pre: null, answers: Object.fromEntries(answered) };
  };
  const checkedBy = (round: Round, name: JudgeName) => round.answers[name]!.checked;
  const dualOf = (round: Round, lane: LaneResult): Combined =>
    round.pre ??
    capVerdict(combine(checkedBy(round, "Spark Open"), checkedBy(round, "Spark 1.3")), lane);
  const aloneOf = (round: Round, name: JudgeName, lane: LaneResult): Outcome =>
    round.pre ?? alone(checkedBy(round, name), lane);

  const [lane1, lane2] = [sides["pr-1"].lane, sides["pr-2"].lane];
  const first = await ask("pr-1", names);
  const dual1 = views.includes("dual") ? dualOf(first, lane1) : null;
  const solo1 = new Map(names.map((name) => [name, aloneOf(first, name, lane1)]));
  // §19 e: the dual verdict re-records on a fail or a tie, one judge alone on its fail.
  const dualAgain = dual1 !== null && rerecordFor(dual1) !== null;
  const soloAgain = (name: JudgeName) => solo1.get(name)!.verdict === "fail";
  const again = names.filter((name) => dualAgain || soloAgain(name));
  const second = again.length > 0 ? await ask("pr-2", again) : null;

  const outcomes: { view: View; outcome: Outcome; again: boolean; who: readonly JudgeName[] }[] =
    [];
  if (dual1) {
    const outcome = dualAgain
      ? afterRerecord(
          dual1,
          [checkedBy(first, "Spark Open"), checkedBy(first, "Spark 1.3")],
          dualOf(second!, lane2),
        )
      : dual1;
    outcomes.push({ view: "dual", outcome, again: dualAgain, who: names });
  }
  for (const name of names) {
    const own = soloAgain(name) ? confirmed(aloneOf(second!, name, lane2)) : solo1.get(name)!;
    outcomes.push({ view: name, outcome: own, again: soloAgain(name), who: [name] });
  }

  const callsOf = (round: Round | null, who: readonly JudgeName[]) =>
    who.flatMap((name) => (round?.answers[name] ? [round.answers[name].call] : []));
  const verdicts = outcomes.map(({ view, outcome, again: twice, who }) => {
    const rounds = twice ? [first, second] : [first];
    const used = rounds.map((round) => callsOf(round, who));
    return {
      ...row,
      view,
      ...outcome,
      take: twice ? ("pr-2" as const) : ("pr-1" as const),
      calls: used.flat().length,
      usd: usd(used.flat().reduce((sum, c) => sum + c.usd, 0)),
      // A take's calls run at once: the slower one is the time it took.
      ms: used.reduce((sum, calls) => sum + Math.max(0, ...calls.map((c) => c.ms)), 0),
    };
  });
  return { verdicts, calls: [...callsOf(first, names), ...callsOf(second, names)] };
}

/** One line per criterion: each view's verdict, and what it cost. */
function lineOf(judging: Judging): string {
  const v = judging.verdicts[0]!;
  const views = judging.verdicts
    .map((x) => `${x.view} ${x.verdict}${x.take === "pr-2" ? " (pr-2)" : ""}`)
    .join(", ");
  const spent = judging.calls.reduce((sum, c) => sum + c.usd, 0);
  const ms = Math.max(0, ...judging.verdicts.map((x) => x.ms));
  return `${itemKey(v)} [${v.label}]: ${views} · ${judging.calls.length} calls, $${spent.toFixed(4)}, ${(ms / 1000).toFixed(1)} s`;
}

/** Judges every item under every arm, `repeats` times, skipping what's done; repeat by repeat. */
export async function judgeAll(
  items: readonly BenchItem[],
  options: JudgeOptions,
): Promise<JudgeSummary> {
  const redact = options.redact ?? ((text: string) => text);
  const work: { arm: Arm; repeat: number; item: BenchItem; key: string }[] = [];
  for (let repeat = 1; repeat <= options.repeats; repeat++)
    for (const arm of options.arms)
      for (const item of items) {
        const key = itemKey({ arm, repeat, case: item.case.id, criterion: item.criterion.id });
        if (!options.done?.has(key)) work.push({ arm, repeat, item, key });
      }
  const total = options.repeats * options.arms.length * items.length;
  options.log(`${total - work.length} judged before, ${work.length} to judge`);

  const maxUsd = options.maxUsd ?? Infinity;
  const maxOpenUsd = options.maxOpenUsd ?? Infinity;
  const summary: JudgeSummary = {
    judged: 0,
    crashed: [],
    stopped: null,
    left: 0,
    usd: 0,
    openUsd: 0,
  };
  const queue = [...work];
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      if (summary.usd >= maxUsd) {
        summary.stopped = `the calls cost $${summary.usd.toFixed(2)}: the --max-usd cap`;
      } else if (ARM_JUDGES[next.arm].includes("Spark Open") && summary.openUsd >= maxOpenUsd) {
        summary.stopped = `Spark Open cost $${summary.openUsd.toFixed(2)}: the --max-open-usd cap`;
      }
      if (summary.stopped) {
        queue.unshift(next);
        return;
      }
      try {
        const judging = await judgeItem(next.arm, next.repeat, next.item, options);
        for (const call of judging.calls) {
          summary.usd += call.usd;
          if (call.judge === "Spark Open") summary.openUsd += call.usd;
        }
        summary.judged++;
        options.onJudged?.(judging);
        options.log(lineOf(judging));
      } catch (err) {
        summary.crashed.push(next.key);
        options.log(
          redact(`${next.key}: crashed, not judged: ${(err as Error).message}`).slice(0, 300),
        );
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 4) }, worker));
  summary.left = queue.length;
  return summary;
}
