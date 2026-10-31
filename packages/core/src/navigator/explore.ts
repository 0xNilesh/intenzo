import type { Browser, Locator, Page } from "playwright";

import { now } from "../browser/clock.ts";
import { acquireIdentity, openLane, type Lane } from "../browser/lane.ts";
import { buildOutline, refLocator, renderOutline, type Outline } from "../browser/outline.ts";
import { Settler } from "../browser/settle.ts";
import {
  addUsage,
  NO_USAGE,
  type ModelPort,
  type ModelResult,
  type ModelUsage,
  type ReasoningEffort,
} from "../models/port.ts";
import {
  NAVIGATE_JSON_SCHEMA,
  NAVIGATE_SYSTEM,
  NAVIGATE_V1,
  NavigateReply,
  describeOp,
  renderNavigate,
  type NavigateHistoryItem,
} from "../prompts/navigate.v1.ts";
import {
  SavedPath,
  type Criterion,
  type NavAction,
  type NavOp,
  type Step,
  type WatchTarget,
} from "../schema/index.ts";
import { durableTarget, regionWatchFor, type RoleName } from "./durable.ts";
import { guardAction } from "./guard.ts";

// The explore loop (ARCHITECTURE §20.3): the model reads the page outline and picks one action at
// a time; code checks it (the guard), turns its element into a durable target, runs it and
// settles the page, until the model says the trigger is done. The result is a SavedPath, which
// the recorder replays cleanly: exploration is never the evidence (§20.6).

export const NAVIGATOR_MODEL = "muse-wonder-1.0";
export const EXPLORE_BUDGET = { steps: 25, ms: 120_000 } as const;
/** §20.3 shows the model its last 6 steps. */
export const HISTORY_WINDOW = 6;
const ACTION_TIMEOUT_MS = 5000;
const NAVIGATION_TIMEOUT_MS = 15_000;
const MAX_MODEL_FAILURES = 3;

export interface ExploreOptions {
  /** The app under test (the PR preview). */
  origin: string;
  criterion: Pick<Criterion, "id" | "trigger" | "setup" | "watch">;
  model: ModelPort;
  modelId?: string;
  reasoningEffort?: ReasoningEffort;
  /** Session hook for a fresh user (§21.1). The model never handles identity. */
  identity?: { hookPath: string; secret: string };
  bypass?: string;
  allowedNavigationOrigins?: readonly string[];
  /** The action denylist (config/derive.ts denyText). */
  denyText: readonly string[];
  /** Where exploring starts (startPathFor). */
  startPath?: string;
  budget?: { steps: number; ms: number };
  data?: readonly string[];
  repro?: readonly string[];
  /** Called with a line per step, for CLIs and logs. */
  log?: (line: string) => void;
}

export interface ExploreStep {
  n: number;
  action: NavAction | null;
  /** What happened, as the model was told. */
  result: string;
  ok: boolean;
  /** The durable step it became, when it ran. */
  step?: Step;
}

interface Explored {
  steps: ExploreStep[];
  ms: number;
  usage: ModelUsage;
  modelCalls: number;
}

export type ExploreResult =
  | (Explored & { status: "found"; path: SavedPath })
  | (Explored & { status: "setup_failed" | "trigger_absent"; reason: string });

/**
 * §20.3's start route: the ticket's own start path, else the route whose words best match the
 * criterion (e.g. "/cart" for "on the cart"), else the config's start.default.
 */
export function startPathFor(input: {
  criterion: Pick<Criterion, "trigger" | "setup">;
  reproStartPath?: string;
  routes?: readonly string[];
  fallback?: string;
}): string {
  if (input.reproStartPath) return input.reproStartPath;
  const words = new Set(
    [input.criterion.trigger, ...input.criterion.setup]
      .join(" ")
      .toLowerCase()
      .match(/[a-z]+/g) ?? [],
  );
  let best: { path: string; score: number } | null = null;
  for (const route of input.routes ?? []) {
    const parts = route.toLowerCase().match(/[a-z]+/g) ?? [];
    const score = parts.filter(
      (p) => words.has(p) || words.has(`${p}s`) || words.has(p.replace(/s$/, "")),
    ).length;
    if (score > 0 && (!best || score > best.score)) best = { path: route, score };
  }
  return best?.path ?? input.fallback ?? "/";
}

export async function explore(browser: Browser, options: ExploreOptions): Promise<ExploreResult> {
  const started = now();
  const budget = options.budget ?? EXPLORE_BUDGET;
  const startPath = options.startPath ?? "/";
  const log = options.log ?? (() => {});
  const steps: ExploreStep[] = [];
  let usage = NO_USAGE;
  let modelCalls = 0;
  const done = (): Explored => ({ steps, ms: Math.round(now() - started), usage, modelCalls });
  const fail = (status: "setup_failed" | "trigger_absent", reason: string): ExploreResult => {
    log(`→ ${status}: ${reason}`);
    return { status, reason, ...done() };
  };

  const lane: Lane = await openLane(browser, {
    origin: options.origin,
    ...(options.bypass && { bypass: options.bypass }),
    ...(options.allowedNavigationOrigins && {
      allowedNavigationOrigins: options.allowedNavigationOrigins,
    }),
  });
  try {
    const { page, context } = lane;
    context.setDefaultTimeout(ACTION_TIMEOUT_MS);
    context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    const settler = await Settler.install(context, lane.origin);
    if (options.identity) await acquireIdentity(lane, options.identity);

    // The setup starts where exploring started, so a replay starts there too.
    const setup: Step[] = [{ op: "goto", path: startPath }];
    const trigger: Step[] = [];
    try {
      await page.goto(new URL(startPath, lane.origin).href);
    } catch (err) {
      return fail("setup_failed", `couldn't open ${startPath}: ${firstLine(err)}`);
    }
    await settler.settle(page);

    const expand: string[] = [];
    let lastResult: string | null = null;
    let modelFailures = 0;

    for (let n = 1; n <= budget.steps; n++) {
      if (now() - started > budget.ms)
        return fail("setup_failed", `budget: ${budget.ms / 1000} s ran out`);
      const outline = await buildOutline(page, { collapseLandmarks: n > 1, expand });
      const history: NavigateHistoryItem[] = steps.slice(-HISTORY_WINDOW).map((s) => ({
        n: s.n,
        phase: s.action?.phase ?? "?",
        action: s.action?.action ?? null,
        result: s.result,
      }));
      const reply: ModelResult<NavAction> = await options.model.call<NavAction>({
        stage: "navigate",
        model: options.modelId ?? NAVIGATOR_MODEL,
        promptVersion: NAVIGATE_V1,
        messages: [
          { role: "system", content: NAVIGATE_SYSTEM },
          {
            role: "user",
            content: renderNavigate({
              criterion: options.criterion,
              outline: renderOutline(outline),
              history,
              lastResult,
              step: n,
              maxSteps: budget.steps,
              ...(options.data && { data: options.data }),
              ...(options.repro && { repro: options.repro }),
            }),
          },
        ],
        schema: NavigateReply,
        jsonSchema: { name: "NavAction", schema: NAVIGATE_JSON_SCHEMA },
        reasoningEffort: options.reasoningEffort ?? "low",
        timeoutMs: 60_000,
      });
      modelCalls += reply.requests;
      usage = addUsage(usage, reply.usage);
      if (!reply.ok) {
        lastResult = `Your reply couldn't be used (${reply.error.slice(0, 200)}). Reply with one valid JSON object.`;
        steps.push({ n, action: null, result: lastResult, ok: false });
        log(`${n}. model error: ${reply.error.slice(0, 120)}`);
        if (++modelFailures >= MAX_MODEL_FAILURES)
          return fail("setup_failed", `the model failed ${modelFailures} times in a row`);
        continue;
      }
      modelFailures = 0;
      const action: NavAction = reply.output;
      log(
        `${n}. [${action.phase}] ${describeOp(action.action ?? null)} · ${action.status} · ${action.thought}`,
      );

      if (action.status === "give_up") {
        steps.push({ n, action, result: `gave up: ${action.reason}`, ok: true });
        // trigger_not_found after the setup is done means the app lacks the control (§20.3).
        return action.reason === "trigger_not_found" && action.phase === "trigger"
          ? fail(
              "trigger_absent",
              `the navigator found no control for the trigger: ${action.thought}`,
            )
          : fail("setup_failed", `${action.reason}: ${action.thought}`);
      }

      const guard = await guardAction(action, {
        origin: lane.origin,
        allowedNavigationOrigins: options.allowedNavigationOrigins ?? [],
        refs: outline.refs,
        resolve: (ref) => refLocator(page, ref, { fallback: outline.fallback }),
        denyText: options.denyText,
      });
      if (!guard.ok) {
        lastResult = `Refused: ${guard.message}`;
        steps.push({ n, action, result: lastResult, ok: false });
        log(`   refused (${guard.code})`);
        continue;
      }

      const op: NavOp = action.action!;
      if (op.op === "expand") {
        expand.push(op.ref);
        lastResult = `${op.ref} will be shown in full in the next outline.`;
        steps.push({ n, action, result: lastResult, ok: true });
        continue;
      }

      // Everything that names an element is resolved before the action can change the page.
      const element =
        "ref" in op && op.ref ? refLocator(page, op.ref, { fallback: outline.fallback }) : null;
      let step: Step;
      let watch: WatchTarget[] = [];
      try {
        const hint = "ref" in op && op.ref ? roleNameIn(outline, op.ref) : null;
        step = await toStep(page, op, element, hint);
        if (action.status === "trigger_done")
          watch = await watchTargets(page, action, outline, element);
      } catch (err) {
        lastResult = `Couldn't use ${describeOp(op)}: ${firstLine(err)}`;
        steps.push({ n, action, result: lastResult, ok: false });
        continue;
      }

      const leftBefore = lane.offOriginNavigations.length;
      try {
        await run(page, lane.origin, op, element);
      } catch (err) {
        lastResult = `${describeOp(op)} failed: ${firstLine(err)}`;
        steps.push({ n, action, result: lastResult, ok: false, step });
        continue;
      }
      await settler.settle(page);
      if (lane.offOriginNavigations.length > leftBefore) {
        return fail(
          "setup_failed",
          `the page left the app for ${lane.offOriginNavigations.at(-1)}`,
        );
      }

      if (action.phase === "trigger") trigger.push(step);
      else {
        // A setup step after trigger steps means those weren't the trigger after all.
        setup.push(...trigger.splice(0), step);
      }
      lastResult = `ok, now on ${pathOf(page)}`;
      steps.push({ n, action, result: lastResult, ok: true, step });

      if (action.status === "trigger_done") {
        if (action.phase !== "trigger") {
          // The model finished with a step it called setup: it's still the trigger.
          trigger.push(setup.pop()!);
        }
        const path = SavedPath.parse({
          criterionId: options.criterion.id,
          setup,
          trigger,
          watch,
          portable: true,
        });
        log(`→ found in ${n} steps, ${Math.round((now() - started) / 100) / 10} s`);
        return { status: "found", path, ...done() };
      }
    }
    return fail("setup_failed", `budget: ${budget.steps} steps ran out`);
  } finally {
    await lane.close();
  }
}

/** The durable Step an action becomes (§20.4). */
async function toStep(
  page: Page,
  op: NavOp,
  element: Locator | null,
  hint: RoleName | null,
): Promise<Step> {
  const target = element ? await durableTarget(page, element, hint) : undefined;
  switch (op.op) {
    case "goto":
      return { op: "goto", path: op.path };
    case "click":
      return { op: "click", target: target! };
    case "fill":
      return { op: "fill", target: target!, value: op.value };
    case "select":
      return { op: "select", target: target!, option: op.option };
    case "press":
      return { op: "press", key: op.key };
    case "scroll":
      return { op: "scroll", direction: op.direction, ...(target && { target }) };
    case "wait":
      return { op: "wait", ms: op.ms };
    case "back":
      return { op: "back" };
    case "expand":
      throw new Error("expand isn't a step");
  }
}

/**
 * The trigger's watch targets: the elements the model named, plus §20.4's automatic region around
 * the trigger element (or main). Live regions are always read, so they need no target.
 */
async function watchTargets(
  page: Page,
  action: NavAction,
  outline: Outline,
  element: Locator | null,
): Promise<WatchTarget[]> {
  const watch: WatchTarget[] = [];
  for (const w of action.watch ?? []) {
    try {
      const el = refLocator(page, w.ref, { fallback: outline.fallback });
      const target = await durableTarget(page, el, roleNameIn(outline, w.ref));
      if (!watch.some((x) => x.label === w.label))
        watch.push({ label: w.label, scope: "element", target });
    } catch {
      // A watch element that can't be found again is left out; the region still covers it.
    }
  }
  const region = await regionWatchFor(page, element ?? page.locator("main, body").first());
  const label = watch.some((w) => w.label === region.label)
    ? `${region.label} region`
    : region.label;
  watch.push({ ...region, label });
  return watch;
}

async function run(page: Page, origin: string, op: NavOp, element: Locator | null): Promise<void> {
  switch (op.op) {
    case "goto":
      await page.goto(new URL(op.path, origin).href);
      return;
    case "click":
      await element!.click();
      return;
    case "fill":
      await element!.fill(op.value);
      return;
    case "select":
      await element!.selectOption(op.option);
      return;
    case "press":
      await page.keyboard.press(op.key);
      return;
    case "scroll":
      if (element) await element.scrollIntoViewIfNeeded();
      else await page.mouse.wheel(0, op.direction === "down" ? 600 : -600);
      return;
    case "wait":
      await page.waitForTimeout(op.ms);
      return;
    case "back":
      await page.goBack();
      return;
    case "expand":
      return;
  }
}

/**
 * The exact role and name Playwright gave a ref, from its outline line (`button "Apply" [ref=e8]`),
 * so durable targets use Playwright's own accessible names.
 */
export function roleNameIn(outline: Pick<Outline, "text">, ref: string): RoleName | null {
  const line = outline.text.split("\n").find((l) => l.includes(`[ref=${ref}]`));
  const match = line ? /^\s*- ([a-z]+)(?: ("(?:[^"\\]|\\.)*"))?/.exec(line) : null;
  if (!match) return null;
  let name = "";
  if (match[2]) {
    try {
      name = JSON.parse(match[2]) as string;
    } catch {
      name = match[2].slice(1, -1);
    }
  }
  return { role: match[1]!, name };
}

function pathOf(page: Page): string {
  const url = new URL(page.url());
  return url.pathname + url.search;
}

function firstLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split("\n")[0]!.slice(0, 200);
}
