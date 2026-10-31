import type { Locator, Page } from "playwright";

// The page outline the navigator reads (ARCHITECTURE §20.1). Playwright 1.64 made the AI snapshot
// public: page.ariaSnapshot({ mode: "ai" }) is aria-snapshot YAML in which every node carries
// [ref=eN] (f1eN inside iframes), with names from Playwright's own accessible-name logic, and
// page.getByRef(ref) resolves a ref against the latest snapshot. This file is the only place that
// takes snapshots for the navigator; outline.browser.test.ts pins the format.
//
// The data-iz-ref fallback (behind a flag) tags elements in one page.evaluate pass and renders a
// similar outline, for the day the snapshot API changes. settle() ignores those attribute writes.

export const OUTLINE_MAX_TOKENS = 6000;
/** Lists longer than this show their first LIST_KEEP items and "(+N more)" (§20.1). */
export const LIST_KEEP = 8;
const SNAPSHOT_TIMEOUT_MS = 5000;

export interface OutlineOptions {
  maxTokens?: number;
  /**
   * Collapse banner, navigation and contentinfo landmarks to one line. The explore loop passes
   * false on its first turn and true afterwards.
   */
  collapseLandmarks?: boolean;
  /** Refs the model asked to expand: shown in full even when collapsed or list-pruned. */
  expand?: readonly string[];
  /** Use the data-iz-ref fallback instead of the AI snapshot. */
  fallback?: boolean;
}

export interface Outline {
  /** Pruned aria-snapshot YAML; nodes carry [ref=…]. */
  text: string;
  /** Every ref that appears in `text`: the only ids the model may use. */
  refs: ReadonlySet<string>;
  /** About chars / 4. */
  tokens: number;
  truncated: boolean;
  /** The page's path and query, e.g. "/cart". */
  path: string;
  fallback: boolean;
}

export async function buildOutline(page: Page, options: OutlineOptions = {}): Promise<Outline> {
  const fallback = options.fallback ?? false;
  const raw = fallback
    ? await page.evaluate(fallbackSnapshot)
    : await page.ariaSnapshot({ mode: "ai", timeout: SNAPSHOT_TIMEOUT_MS });
  const { text, truncated } = pruneOutline(raw, options);
  const url = new URL(page.url());
  return {
    text,
    refs: refsIn(text),
    tokens: tokensOf(text),
    truncated,
    path: url.pathname + url.search,
    fallback,
  };
}

/** The outline wrapped as untrusted page content for a prompt (§13). */
export function renderOutline(outline: Outline): string {
  // The page's own text must never close the block early.
  const body = outline.text.replace(/<\/?untrusted/gi, (m) => m.replace("<", "&lt;"));
  const path = outline.path.replace(/["<>]/g, encodeURIComponent);
  return `<untrusted source="page_outline" url="${path}">\n${body}\n</untrusted>`;
}

/** A locator for a ref from the latest outline. */
export function refLocator(page: Page, ref: string, options: { fallback?: boolean } = {}): Locator {
  return options.fallback ? page.locator(`[data-iz-ref="${ref}"]`) : page.getByRef(ref);
}

// ── Pruning (pure, so it's unit-tested on text) ──────────────────────────────────────────────

export const REF = /\[ref=([a-z0-9]+)\]/;

export const tokensOf = (text: string): number => Math.ceil(text.length / 4);

export function refsIn(text: string): Set<string> {
  return new Set([...text.matchAll(new RegExp(REF, "g"))].map((m) => m[1]!));
}

export interface OutlineNode {
  /** The line without its indentation or "- " marker. */
  line: string;
  children: OutlineNode[];
}

/** Parses snapshot YAML into a tree by indentation (two spaces a level). */
export function parseOutline(text: string): OutlineNode[] {
  const roots: OutlineNode[] = [];
  const stack: { depth: number; node: OutlineNode }[] = [];
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    const indent = raw.length - raw.trimStart().length;
    const depth = Math.floor(indent / 2);
    const node: OutlineNode = { line: raw.trim().replace(/^- /, ""), children: [] };
    while (stack.length > 0 && stack.at(-1)!.depth >= depth) stack.pop();
    (stack.at(-1)?.node.children ?? roots).push(node);
    stack.push({ depth, node });
  }
  return roots;
}

function render(nodes: readonly OutlineNode[], depth = 0, out: string[] = []): string[] {
  for (const node of nodes) {
    out.push(`${"  ".repeat(depth)}- ${node.line}`);
    render(node.children, depth + 1, out);
  }
  return out;
}

const roleOf = (line: string): string => /^[a-z/]+/i.exec(line)?.[0] ?? "";
const refOf = (line: string): string | undefined => REF.exec(line)?.[1];
const LANDMARKS = new Set(["banner", "navigation", "contentinfo"]);
const INTERACTIVE =
  /^(link|button|textbox|searchbox|combobox|checkbox|radio|switch|tab|menuitem|option|slider|spinbutton)\b/;

/** `link "Cart (2)"` from `link "Cart (2)" [ref=e6] [cursor=pointer]:`. */
function shortName(line: string): string {
  return line
    .replace(/\s*\[[^\]]*\]/g, "")
    .replace(/:.*$/, "")
    .trim();
}

function interactiveIn(nodes: readonly OutlineNode[], found: string[] = []): string[] {
  for (const node of nodes) {
    if (INTERACTIVE.test(node.line)) found.push(shortName(node.line));
    interactiveIn(node.children, found);
  }
  return found;
}

function prune(
  nodes: OutlineNode[],
  collapse: boolean,
  expand: ReadonlySet<string>,
): OutlineNode[] {
  return nodes.map((node) => {
    const ref = refOf(node.line);
    const expanded = ref !== undefined && expand.has(ref);
    if (collapse && !expanded && LANDMARKS.has(roleOf(node.line)) && node.children.length > 0) {
      const items = interactiveIn(node.children);
      const shown = items.slice(0, 6).join(", ") + (items.length > 6 ? ", …" : "");
      const line = node.line.replace(/:$/, "");
      return { line: `${line} (collapsed${shown ? `: ${shown}` : ""})`, children: [] };
    }
    // An expanded landmark shows its nested landmarks too.
    let children = prune(node.children, collapse && !expanded, expand);
    const role = roleOf(children[0]?.line ?? "");
    const similar = children.length > LIST_KEEP && children.every((c) => roleOf(c.line) === role);
    if (similar && !expanded) {
      const more = children.length - LIST_KEEP;
      children = [...children.slice(0, LIST_KEEP), { line: `(+${more} more)`, children: [] }];
    }
    return { line: node.line, children };
  });
}

function maxDepth(nodes: readonly OutlineNode[], depth = 1): number {
  return Math.max(
    depth,
    ...nodes.map((n) => (n.children.length ? maxDepth(n.children, depth + 1) : depth)),
  );
}

/** Replaces every node deeper than `limit` with one "(+N hidden)" line per parent. */
function cutBelow(nodes: OutlineNode[], limit: number, depth = 1): OutlineNode[] {
  return nodes.map((node) => {
    if (node.children.length === 0) return node;
    if (depth + 1 > limit) {
      return {
        line: node.line,
        children: [{ line: `(+${count(node.children)} hidden)`, children: [] }],
      };
    }
    return { line: node.line, children: cutBelow(node.children, limit, depth + 1) };
  });
}

const count = (nodes: readonly OutlineNode[]): number =>
  nodes.reduce((n, node) => n + 1 + count(node.children), 0);

/**
 * §20.1's pruning: landmarks collapsed (unless expanded), long lists of same-role items cut to
 * LIST_KEEP, then the token cap: the deepest level is folded away until the outline fits, and as
 * a last resort the text is cut with a marker.
 */
export function pruneOutline(
  raw: string,
  options: Omit<OutlineOptions, "fallback"> = {},
): { text: string; truncated: boolean } {
  const maxTokens = options.maxTokens ?? OUTLINE_MAX_TOKENS;
  let tree = prune(parseOutline(raw), options.collapseLandmarks ?? true, new Set(options.expand));
  let lines = render(tree);
  let truncated = false;
  for (
    let limit = maxDepth(tree) - 1;
    tokensOf(lines.join("\n")) > maxTokens && limit >= 1;
    limit--
  ) {
    tree = cutBelow(tree, limit);
    lines = render(tree);
    truncated = true;
  }
  if (tokensOf(lines.join("\n")) > maxTokens) {
    const marker = "- (… truncated)";
    const kept: string[] = [];
    let chars = marker.length;
    for (const line of lines) {
      if ((chars + line.length + 1) / 4 > maxTokens) break;
      kept.push(line);
      chars += line.length + 1;
    }
    lines = [...kept, marker];
    truncated = true;
  }
  return { text: lines.join("\n"), truncated };
}

// ── The data-iz-ref fallback ─────────────────────────────────────────────────────────────────

/** Runs in the page: tags elements with data-iz-ref="eN" and returns an outline of them. */
function fallbackSnapshot(): string {
  for (const el of document.querySelectorAll("[data-iz-ref]")) el.removeAttribute("data-iz-ref");
  const IMPLICIT: Record<string, string> = {
    BUTTON: "button",
    SELECT: "combobox",
    TEXTAREA: "textbox",
    UL: "list",
    OL: "list",
    LI: "listitem",
    NAV: "navigation",
    MAIN: "main",
    FORM: "form",
    DIALOG: "dialog",
    TABLE: "table",
    TR: "row",
    TD: "cell",
    TH: "columnheader",
    P: "paragraph",
    IFRAME: "iframe",
  };
  const clean = (s: string | null | undefined) =>
    (s ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  const roleOf = (el: Element): string | null => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName;
    if (/^H[1-6]$/.test(tag)) return "heading";
    if (tag === "A") return el.hasAttribute("href") ? "link" : null;
    if (tag === "IMG") return el.getAttribute("alt") ? "img" : null;
    if (tag === "HEADER") return el.closest("article, section, main") ? null : "banner";
    if (tag === "FOOTER") return el.closest("article, section, main") ? null : "contentinfo";
    if (tag === "SECTION")
      return el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby") ? "region" : null;
    if (tag === "INPUT") {
      const type = (el as HTMLInputElement).type;
      if (type === "hidden") return null;
      if (type === "checkbox" || type === "radio") return type;
      if (["button", "submit", "reset"].includes(type)) return "button";
      return "textbox";
    }
    return IMPLICIT[tag] ?? null;
  };
  const nameOf = (el: Element, role: string): string => {
    const label = el.getAttribute("aria-label");
    if (label) return clean(label);
    const by = el.getAttribute("aria-labelledby");
    if (by)
      return clean(
        by
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent)
          .join(" "),
      );
    if (el.matches("input, select, textarea")) {
      const forLabel = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
      return clean(
        (forLabel ?? el.closest("label"))?.textContent ?? el.getAttribute("placeholder"),
      );
    }
    if (role === "img") return clean(el.getAttribute("alt"));
    if (["link", "button", "heading", "tab", "menuitem", "option"].includes(role)) {
      return clean((el as HTMLElement).innerText);
    }
    return "";
  };
  const hidden = (el: Element) => {
    if (el.getAttribute("aria-hidden") === "true") return true;
    const style = getComputedStyle(el);
    return style.display === "none" || style.visibility === "hidden";
  };
  let n = 0;
  const out: string[] = [];
  const walk = (el: Element, depth: number) => {
    if (hidden(el) || ["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"].includes(el.tagName)) return;
    const role = roleOf(el);
    let childDepth = depth;
    if (role) {
      const ref = `e${++n}`;
      el.setAttribute("data-iz-ref", ref);
      const name = nameOf(el, role);
      const leafText =
        !["link", "button", "heading"].includes(role) && el.children.length === 0
          ? clean(el.textContent)
          : "";
      out.push(
        `${"  ".repeat(depth)}- ${role}${name ? ` "${name}"` : ""} [ref=${ref}]${leafText ? `: ${leafText}` : ""}`,
      );
      childDepth = depth + 1;
      if (el.children.length === 0) return;
    }
    for (const node of el.childNodes) {
      if (node.nodeType === 3 && !role) {
        const text = clean(node.textContent);
        if (text) out.push(`${"  ".repeat(childDepth)}- text: ${text}`);
      } else if (node.nodeType === 1) {
        walk(node as Element, childDepth);
      }
    }
  };
  walk(document.body, 0);
  return out.join("\n");
}
