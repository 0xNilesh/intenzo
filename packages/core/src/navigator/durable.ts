import type { Locator, Page } from "playwright";

import { locate } from "../browser/readings.ts";
import type { Target, WatchTarget } from "../schema/index.ts";

// Durable targets (§20.4): the navigator acts on an outline ref, which only lives until the next
// snapshot, so code turns the chosen element into a Target the recorder can find again. Every
// candidate is checked the way the recorder will replay it (readings.ts locate()): it must match
// exactly one element where uniqueness matters, and that element must be the chosen one. So a
// saved target can never point at a different "Add to cart".

type AriaRole = Parameters<Page["getByRole"]>[0];

/** Roles that name nothing useful to find an element by. */
const NAMELESS_ROLES = new Set(["generic", "text", "none", "presentation", "paragraph"]);

export async function isSameElement(a: Locator, b: Locator): Promise<boolean> {
  try {
    const handle = await b.elementHandle({ timeout: 1000 });
    if (!handle) return false;
    try {
      return await a.evaluate((x, y) => x === y, handle, { timeout: 1000 });
    } finally {
      await handle.dispose();
    }
  } catch {
    return false; // a matched several elements, or neither resolved
  }
}

export interface RoleName {
  role: string;
  name: string;
}

/** An in-page estimate of an element's role and accessible name (explicit or common implicit). */
export async function estimateRoleName(el: Locator): Promise<RoleName | null> {
  return el.evaluate((node) => {
    const clean = (t: string | null | undefined) => (t ?? "").replace(/\s+/g, " ").trim();
    const tag = node.tagName;
    const implicit = (): string | null => {
      if (/^H[1-6]$/.test(tag)) return "heading";
      if (tag === "A") return node.hasAttribute("href") ? "link" : null;
      if (tag === "BUTTON" || tag === "SUMMARY") return "button";
      if (tag === "SELECT") return "combobox";
      if (tag === "TEXTAREA") return "textbox";
      if (tag === "INPUT") {
        const type = (node as HTMLInputElement).type;
        if (["button", "submit", "reset"].includes(type)) return "button";
        if (type === "checkbox" || type === "radio") return type;
        return type === "hidden" ? null : "textbox";
      }
      const named = node.hasAttribute("aria-label") || node.hasAttribute("aria-labelledby");
      if (tag === "FORM") return named ? "form" : null;
      if (tag === "SECTION") return named ? "region" : null;
      return (
        {
          NAV: "navigation",
          MAIN: "main",
          DIALOG: "dialog",
          UL: "list",
          OL: "list",
          LI: "listitem",
          IMG: "img",
          ASIDE: "complementary",
        }[tag] ?? null
      );
    };
    const role = node.getAttribute("role") ?? implicit();
    if (!role) return null;
    const labelledBy = node.getAttribute("aria-labelledby");
    const fieldLabel = () => {
      const byFor = node.id ? document.querySelector(`label[for="${CSS.escape(node.id)}"]`) : null;
      return (byFor ?? node.closest("label"))?.textContent ?? null;
    };
    const name =
      node.getAttribute("aria-label") ??
      (labelledBy
        ? labelledBy
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent ?? "")
            .join(" ")
        : null) ??
      (node.matches("input, select, textarea") ? fieldLabel() : null) ??
      node.getAttribute("alt") ??
      (["button", "link", "heading", "tab", "menuitem", "option", "checkbox", "radio"].includes(
        role,
      )
        ? (node as HTMLElement).innerText
        : null) ??
      "";
    return { role, name: clean(name) };
  });
}

/**
 * The first candidate, in §20.4's order, that resolves to exactly the chosen element: test id,
 * role + name, label, placeholder, role + name + nth, then the shortest unique CSS path.
 * Throws if `el` doesn't match exactly one element.
 */
export async function durableTarget(
  page: Page,
  el: Locator,
  hint?: RoleName | null,
): Promise<Target> {
  const count = await el.count();
  if (count !== 1)
    throw new Error(`the chosen element must match exactly one element (it matched ${count})`);

  // Unique, and the element replay finds is the chosen one.
  const holds = async (all: Locator, target: Target) =>
    (await all.count()) === 1 && (await isSameElement(locate(page, target), el));

  const facts = await el.evaluate((node) => {
    const label =
      node.getAttribute("aria-label") ??
      (node.id
        ? document.querySelector(`label[for="${CSS.escape(node.id)}"]`)?.textContent
        : null) ??
      node.closest("label")?.textContent ??
      null;
    return {
      testId: node.getAttribute("data-testid"),
      label: label?.replace(/\s+/g, " ").trim() || null,
      placeholder: node.getAttribute("placeholder"),
      labellable: node.matches("input, select, textarea, [aria-label]"),
    };
  });

  if (facts.testId) {
    const target: Target = { by: "testId", id: facts.testId };
    if (await holds(page.getByTestId(facts.testId), target)) return target;
  }
  const rn = hint ?? (await estimateRoleName(el));
  const named = rn && rn.name !== "" && !NAMELESS_ROLES.has(rn.role) ? rn : null;
  if (named) {
    const target: Target = { by: "role", role: named.role, name: named.name };
    if (await holds(page.getByRole(named.role as AriaRole, { name: named.name }), target))
      return target;
  }
  if (facts.label && facts.labellable) {
    const target: Target = { by: "label", text: facts.label };
    if (await holds(page.getByLabel(facts.label), target)) return target;
  }
  if (facts.placeholder) {
    const target: Target = { by: "placeholder", text: facts.placeholder };
    if (await holds(page.getByPlaceholder(facts.placeholder), target)) return target;
  }
  if (named) {
    const all = page.getByRole(named.role as AriaRole, { name: named.name });
    const n = await all.count();
    for (let nth = 0; nth < n; nth++) {
      if (await isSameElement(all.nth(nth), el)) {
        const target: Target = { by: "role", role: named.role, name: named.name, nth };
        if (await isSameElement(locate(page, target), el)) return target;
        break;
      }
    }
  }
  const selector = await el.evaluate(shortestUniqueCss);
  const target: Target = { by: "css", selector };
  if (await holds(page.locator(selector), target)) return target;
  throw new Error(`no target resolves to the chosen element (last tried css ${selector})`);
}

/** Runs in the page: the shortest unique "a > b:nth-of-type(2)" path to the element. */
function shortestUniqueCss(el: Element): string {
  const segments: string[] = [];
  for (
    let node: Element | null = el;
    node && node !== document.documentElement;
    node = node.parentElement
  ) {
    if (node.id && document.querySelectorAll(`#${CSS.escape(node.id)}`).length === 1) {
      segments.unshift(`#${CSS.escape(node.id)}`);
      break;
    }
    const tag = node.tagName.toLowerCase();
    const siblings = node.parentElement
      ? [...node.parentElement.children].filter((c) => c.tagName === node!.tagName)
      : [node];
    segments.unshift(
      siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(node) + 1})` : tag,
    );
  }
  for (let take = 1; take <= segments.length; take++) {
    const selector = segments.slice(-take).join(" > ");
    const found = document.querySelectorAll(selector);
    if (found.length === 1 && found[0] === el) return selector;
  }
  return segments.join(" > ");
}

// The nearest enclosing form, dialog, named region or landmark (§20.4).
const REGION_XPATH =
  "xpath=ancestor::*[self::form or self::dialog or self::main or self::nav or self::aside or " +
  "@role='form' or @role='dialog' or @role='alertdialog' or @role='region' or @role='main' or " +
  "@role='navigation' or @role='complementary' or @role='search' or " +
  "(self::section and (@aria-label or @aria-labelledby))][1]";

/**
 * §20.4's automatic region watch: the nearest ancestor of `el` that is a form, dialog, named
 * region or landmark, else <main>, else <body>, as a scope "region" WatchTarget.
 */
export async function regionWatchFor(page: Page, el: Locator): Promise<WatchTarget> {
  const candidates = [el.locator(REGION_XPATH), page.locator("main"), page.locator("body")];
  for (const region of candidates) {
    if ((await region.count()) !== 1) continue;
    const target = await durableTarget(page, region);
    const rn = await estimateRoleName(region).catch(() => null);
    const label = rn?.name || rn?.role || (await region.evaluate((n) => n.tagName.toLowerCase()));
    return { label, scope: "region", target };
  }
  throw new Error("the page has no body");
}
