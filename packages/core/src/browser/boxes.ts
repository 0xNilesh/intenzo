import type { BrowserContext, Page } from "playwright";

import type { Target, WatchTarget } from "../schema/index.ts";

// The box poller (§21.3 step 4). An init script runs on every document the lane loads, so the
// track survives navigations: each animation frame it re-finds the element watch targets and logs
// their getBoundingClientRect, stamped with the canonical clock, into a page-side buffer. The
// recorder drains that buffer at each reading and before each step (a navigation drops whatever
// wasn't drained). Only changes are logged, so a still page costs one sample per target.
//
// The page can't run Playwright locators, so the script resolves targets itself: test id, CSS,
// placeholder, label, and role + name (explicit or common implicit roles; the name matched as a
// case-insensitive substring, as getByRole does). That's enough to place annotation boxes; the
// readings themselves always use real locators (readings.ts).

/** One sample: canonical time, the watch label, and the box ([x, y, w, h], null when not shown). */
export interface BoxSample {
  tMs: number;
  label: string;
  box: [number, number, number, number] | null;
}

const BUFFER = "__intenzoBoxes";

interface Watched {
  label: string;
  target: Exclude<Target, { by: "point" }>;
}

export class BoxPoller {
  readonly track: BoxSample[] = [];

  /** Installs the poller on every page and document the context opens from now on. */
  static async install(context: BrowserContext, watch: readonly WatchTarget[]): Promise<BoxPoller> {
    const watched: Watched[] = watch.flatMap((w) =>
      w.scope === "element" && w.target.by !== "point"
        ? [{ label: w.label, target: w.target }]
        : [],
    );
    await context.addInitScript(poll, { buffer: BUFFER, watched });
    return new BoxPoller();
  }

  /** Moves the page's buffered samples into `track`. */
  async drain(page: Page): Promise<BoxSample[]> {
    const samples = await page
      .evaluate((buffer) => {
        const w = window as unknown as Record<string, BoxSample[] | undefined>;
        const taken = w[buffer] ?? [];
        w[buffer] = [];
        return taken;
      }, BUFFER)
      .catch(() => [] as BoxSample[]); // navigating: the samples went with the old document
    this.track.push(...samples);
    return samples;
  }
}

/** Runs in the page, once per document. Self-contained: it can't reach anything in this module. */
function poll({ buffer, watched }: { buffer: string; watched: Watched[] }): void {
  if (window.top !== window) return; // main frame only
  const w = window as unknown as Record<string, BoxSample[] | undefined>;
  w[buffer] = [];
  const last = new Map<string, string>();

  const IMPLICIT: Record<string, string> = {
    button: "button, input[type=button], input[type=submit], input[type=reset], summary",
    link: "a[href], area[href]",
    heading: "h1, h2, h3, h4, h5, h6",
    textbox:
      "textarea, input:not([type]), input[type=text], input[type=email], input[type=tel], input[type=url], input[type=search], input[type=password]",
    checkbox: "input[type=checkbox]",
    radio: "input[type=radio]",
    combobox: "select",
    spinbutton: "input[type=number]",
    img: "img[alt]:not([alt=''])",
    list: "ul, ol",
    listitem: "li",
    navigation: "nav",
    main: "main",
    form: "form",
    table: "table",
    row: "tr",
    cell: "td",
    dialog: "dialog",
  };
  const norm = (s: string | null | undefined) =>
    (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  const labelText = (el: Element) => {
    const byFor = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
    return (byFor ?? el.closest("label"))?.textContent ?? "";
  };
  const nameOf = (el: Element) => {
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      return labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ");
    }
    return (
      el.getAttribute("aria-label") ??
      (el.matches("input, select, textarea") ? labelText(el) : null) ??
      el.getAttribute("alt") ??
      (el as HTMLElement).innerText ??
      el.textContent
    );
  };
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
  };

  const find = (target: Watched["target"]): Element | null => {
    switch (target.by) {
      case "testId":
        return document.querySelector(`[data-testid="${CSS.escape(target.id)}"]`);
      case "css":
        try {
          return document.querySelector(target.selector);
        } catch {
          return null;
        }
      case "placeholder":
        return (
          [...document.querySelectorAll("[placeholder]")].find((el) =>
            norm(el.getAttribute("placeholder")).includes(norm(target.text)),
          ) ?? null
        );
      case "label":
        return (
          [...document.querySelectorAll("input, select, textarea, [aria-label]")].find((el) =>
            norm(el.getAttribute("aria-label") ?? labelText(el)).includes(norm(target.text)),
          ) ?? null
        );
      case "role": {
        const implicit = IMPLICIT[target.role];
        const selector = `[role="${CSS.escape(target.role)}"]${implicit ? `, ${implicit}` : ""}`;
        const matches = [...document.querySelectorAll(selector)].filter((el) => {
          const explicit = el.getAttribute("role");
          if (explicit && explicit !== target.role) return false;
          return visible(el) && norm(nameOf(el)).includes(norm(target.name));
        });
        return matches[target.nth ?? 0] ?? null;
      }
    }
  };

  const sample = () => {
    const tMs = performance.timeOrigin + performance.now();
    for (const { label, target } of watched) {
      const el = find(target);
      let box: BoxSample["box"] = null;
      if (el && visible(el)) {
        const r = el.getBoundingClientRect();
        box = [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
      }
      const key = JSON.stringify(box);
      if (last.get(label) !== key) {
        last.set(label, key);
        w[buffer]!.push({ tMs, label, box });
      }
    }
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
}
