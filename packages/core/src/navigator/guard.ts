import type { Locator } from "playwright";

import type { NavAction } from "../schema/index.ts";

// The action guard (§20.3, §29): code checks every action the model chose before it runs. A
// refusal's message goes back to the model as the step's result, so it says what to do instead.

export interface GuardContext {
  /** The lane origin. */
  origin: string;
  /** The config's extra_navigation_origins. */
  allowedNavigationOrigins: readonly string[];
  /** The current outline's refs: the only ids the model may use. */
  refs: ReadonlySet<string>;
  /** Resolves a ref to a locator (the outline's refLocator), injected so this stays testable. */
  resolve: (ref: string) => Locator;
  /** The action denylist (config/derive.ts denyText), lower case. */
  denyText: readonly string[];
}

export type GuardCode = "bad_op" | "off_origin" | "unknown_ref" | "ambiguous_ref" | "denied";
export type GuardResult = { ok: true } | { ok: false; code: GuardCode; message: string };

const refuse = (code: GuardCode, message: string): GuardResult => ({ ok: false, code, message });

export async function guardAction(action: NavAction, ctx: GuardContext): Promise<GuardResult> {
  const refs = [
    ...(action.action && "ref" in action.action && action.action.ref ? [action.action.ref] : []),
    ...(action.watch ?? []).map((w) => w.ref),
  ];
  for (const ref of refs) {
    if (!ctx.refs.has(ref)) {
      return refuse(
        "unknown_ref",
        `ref ${ref} isn't in the current outline. Use only refs shown in the latest outline; ` +
          `if what you need is collapsed, expand its landmark first.`,
      );
    }
  }

  const op = action.action;
  if (op?.op === "goto") {
    // The schema only takes paths, but "/\\host" still resolves to another host in a URL parser.
    const target = new URL(op.path, ctx.origin).origin;
    if (target !== new URL(ctx.origin).origin && !ctx.allowedNavigationOrigins.includes(target)) {
      return refuse(
        "off_origin",
        `goto ${op.path} leaves the app (${target}). Stay on the app's own pages.`,
      );
    }
  }
  if (!op || op.op === "goto" || op.op === "press" || op.op === "wait" || op.op === "back") {
    return { ok: true };
  }
  if (op.op === "scroll" && !op.ref) return { ok: true };

  const ref = op.ref!;
  const element = ctx.resolve(ref);
  const found = await element.count();
  if (found !== 1) {
    return refuse(
      found === 0 ? "unknown_ref" : "ambiguous_ref",
      found === 0
        ? `ref ${ref} is no longer on the page (it may have changed). Pick a ref from the latest outline.`
        : `ref ${ref} matches ${found} elements. Pick a ref from the latest outline.`,
    );
  }
  if (op.op === "expand") return { ok: true };

  const facts = await element.evaluate((el) => ({
    texts: [
      (el as HTMLElement).innerText,
      el.getAttribute("aria-label"),
      el.getAttribute("title"),
      (el as HTMLInputElement).value,
    ].filter((t): t is string => typeof t === "string" && t.trim() !== ""),
    editable:
      (el instanceof HTMLInputElement &&
        !["button", "submit", "reset", "checkbox", "radio"].includes(el.type)) ||
      el instanceof HTMLTextAreaElement ||
      (el as HTMLElement).isContentEditable,
    isSelect: el instanceof HTMLSelectElement,
  }));
  if (op.op === "click" || op.op === "select" || op.op === "fill") {
    const hit = deniedTerm(facts.texts, ctx.denyText);
    if (hit) {
      return refuse(
        "denied",
        `ref ${ref} ("${hit.text}") matches the denylist ("${hit.term}"): Intenzo never takes destructive or ` +
          `paying actions. Find another way to reach the trigger, or give up with reason "blocked".`,
      );
    }
  }
  if (op.op === "fill" && !facts.editable) {
    return refuse(
      "bad_op",
      `ref ${ref} isn't a text field, so it can't be filled. Click it, or pick its input.`,
    );
  }
  if (op.op === "select" && !facts.isSelect) {
    return refuse("bad_op", `ref ${ref} isn't a <select>. Click it to open its options instead.`);
  }
  return { ok: true };
}

/** The first text that contains a deny term as a whole word or phrase, case-insensitively. */
export function deniedTerm(
  texts: readonly string[],
  terms: readonly string[],
): { text: string; term: string } | null {
  for (const text of texts) {
    const lower = text.toLowerCase().replace(/\s+/g, " ");
    for (const term of terms) {
      const escaped = term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // "pay" stops "Pay now" but not "Display"; "delete" stops "Delete account".
      if (new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, "u").test(lower)) {
        return { text: text.trim().slice(0, 60), term };
      }
    }
  }
  return null;
}
