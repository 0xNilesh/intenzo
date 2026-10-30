import type { Locator, Page } from "playwright";

import type { Reading, Target, WatchTarget } from "../schema/index.ts";
import { now } from "./clock.ts";
import { diffLines, snapshotLines } from "./regions.ts";

// Readings (§21.3 steps 6 and 8). Elements are read as innerText + bbox, regions and live
// regions as aria snapshots that later phases diff against PRE. Every reading is stamped with the
// canonical clock when it's taken.

export const LIVE_REGIONS = "live regions";

export type Phase = Reading["phase"];
type AriaRole = Parameters<Page["getByRole"]>[0];

const LIVE = "[role=alert], [role=status], [role=dialog], [role=alertdialog], [aria-live]";
// Next.js renders an empty body-level role=alert route announcer on every page, which reads out
// the page title on client-side navigations (§21.3). It isn't the app's own feedback, so it's
// left out.
const ANNOUNCERS = "#__next-route-announcer__, next-route-announcer";
// Top-level live regions only: a toast inside an aria-live container is read once, through it.
const TOP_LEVEL_LIVE = `:is(${LIVE}):not(:is(${LIVE}) *):not(${ANNOUNCERS})`;

/** A Playwright locator for a target. Point targets have no element, so they can't be watched. */
export function locate(page: Page, target: Target): Locator {
  switch (target.by) {
    case "testId":
      return page.getByTestId(target.id);
    case "role": {
      const all = page.getByRole(target.role as AriaRole, { name: target.name });
      return target.nth === undefined ? all.first() : all.nth(target.nth);
    }
    case "label":
      return page.getByLabel(target.text).first();
    case "placeholder":
      return page.getByPlaceholder(target.text).first();
    case "css":
      return page.locator(target.selector).first();
    case "point":
      throw new Error("a point target has no element to read");
  }
}

type Box = NonNullable<Reading["bbox"]>;

async function boxOf(locator: Locator): Promise<Box | null> {
  const box = await locator.boundingBox({ timeout: 1000 });
  return box && ([box.x, box.y, box.width, box.height].map(Math.round) as Box);
}

/** innerText + bbox, or kind=absent when the element isn't on the page or isn't visible. */
export async function readElement(
  page: Page,
  watch: WatchTarget,
  phase: Phase,
  i: number,
): Promise<Reading> {
  const element = locate(page, watch.target);
  const tMs = now();
  const absent: Reading = {
    i,
    label: watch.label,
    kind: "absent",
    phase,
    tMs,
    value: null,
    bbox: null,
  };
  try {
    // innerText returns the text of hidden elements too, so visibility decides presence.
    if ((await element.count()) === 0 || !(await element.isVisible())) return absent;
    const value = (await element.innerText({ timeout: 1000 })).replace(/\s+/g, " ").trim();
    return { ...absent, kind: "text", value, bbox: await boxOf(element) };
  } catch {
    return absent; // detached between the checks
  }
}

/** A region's aria snapshot as lines, with its bbox, or null when it isn't on the page. */
export async function snapshotRegion(
  page: Page,
  watch: WatchTarget,
): Promise<{ lines: string[]; bbox: Box | null } | null> {
  const region = locate(page, watch.target);
  try {
    if ((await region.count()) === 0 || !(await region.isVisible())) return null;
    const lines = snapshotLines(await region.ariaSnapshot({ timeout: 1000 }));
    return { lines, bbox: await boxOf(region) };
  } catch {
    return null;
  }
}

/**
 * The aria snapshot lines of every live region: top-level [role=alert|status|dialog|alertdialog]
 * and [aria-live] elements, plus body-level portals (fixed or absolutely positioned children of
 * <body> outside <main>, where toast libraries mount). A live region inside a portal is read once,
 * through the portal.
 */
export async function liveRegionLines(page: Page): Promise<string[]> {
  const regions: Locator[] = [];
  for (const child of await page.locator("body > *").all()) {
    if (await isPortal(child)) regions.push(child);
  }
  for (const live of await page.locator(TOP_LEVEL_LIVE).all()) {
    if (!(await isPortal(live))) regions.push(live);
  }
  const lines: string[] = [];
  for (const region of regions) {
    try {
      lines.push(...snapshotLines(await region.ariaSnapshot({ timeout: 1000 })));
    } catch {
      // gone between listing and reading: nothing to read
    }
  }
  return lines;
}

/** Whether an element is, or sits inside, a body-level portal. */
function isPortal(element: Locator): Promise<boolean> {
  return element
    .evaluate((el, announcers) => {
      let top = el;
      while (top.parentElement && top.parentElement !== document.body) top = top.parentElement;
      if (top.parentElement !== document.body) return false;
      if (["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"].includes(top.tagName)) return false;
      if (top.matches(announcers) || top.querySelector("main")) return false;
      return ["fixed", "absolute"].includes(getComputedStyle(top).position);
    }, ANNOUNCERS)
    .catch(() => false);
}

/**
 * Takes a lane's readings in order. `read("pre")` records each region's and the live regions'
 * lines as text and keeps them as the baseline; later phases record a region_diff against it
 * (against nothing if there was no PRE), and a region that's gone is `absent`.
 */
export class Reader {
  readonly readings: Reading[] = [];
  readonly #page: Page;
  readonly #watch: readonly WatchTarget[];
  readonly #pre = new Map<string, string[]>();

  constructor(page: Page, watch: readonly WatchTarget[]) {
    this.#page = page;
    this.#watch = watch;
  }

  async read(phase: Phase): Promise<Reading[]> {
    const start = this.readings.length;
    for (const watch of this.#watch) {
      if (watch.scope === "element") {
        this.readings.push(await readElement(this.#page, watch, phase, this.readings.length));
        continue;
      }
      const tMs = now();
      const region = await snapshotRegion(this.#page, watch);
      this.#push(watch.label, phase, tMs, region && region.lines, region?.bbox ?? null);
    }
    const tMs = now();
    this.#push(LIVE_REGIONS, phase, tMs, await liveRegionLines(this.#page), null);
    return this.readings.slice(start);
  }

  #push(label: string, phase: Phase, tMs: number, lines: string[] | null, bbox: Box | null): void {
    const reading = { i: this.readings.length, label, phase, tMs, bbox };
    if (lines === null) {
      this.readings.push({ ...reading, kind: "absent", value: null, bbox: null });
    } else if (phase === "pre") {
      this.#pre.set(label, lines);
      this.readings.push({ ...reading, kind: "text", value: lines.join("\n") });
    } else {
      const value = diffLines(this.#pre.get(label) ?? [], lines);
      this.readings.push({ ...reading, kind: "region_diff", value });
    }
  }
}
