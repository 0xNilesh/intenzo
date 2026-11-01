import type { Page } from "playwright";

import { LANDMARK, type SnapshotLine, snapshotLines, subtrees } from "../changes/diff.ts";
import type { Target } from "../schema/index.ts";
import { locate } from "./readings.ts";

// §24: a route's accessibility snapshot for the aria diff, masked, with the lines the criteria's
// trigger targets and watched elements touch. Each target is found with the real locators (as the
// readings do), and its own snapshot's first line marks where it sits in the page's.

export interface RouteSnapshot {
  lines: SnapshotLine[];
  /** Lines a target touches, with everything under them. */
  touched: Set<number>;
}

export async function routeSnapshot(
  page: Page,
  options: { users: readonly string[]; targets: readonly Target[] },
): Promise<RouteSnapshot> {
  const users = options.users;
  const lines = snapshotLines(await page.locator("body").ariaSnapshot(), { users });
  const roots = new Set<number>();
  for (const target of options.targets) {
    if (target.by === "point") continue; // a coordinate has no node of its own
    try {
      const element = locate(page, target).first();
      if ((await element.count()) === 0) continue; // the base app may not have it
      const own = snapshotLines(await element.ariaSnapshot({ timeout: 2_000 }), { users })[0];
      // A container (the navigator watches the Order summary when the discount line isn't there
      // yet, T5.6) is a region: what's inside it goes to the classifier, not out of the diff.
      if (!own || LANDMARK.test(own.text)) continue;
      lines.forEach((line, k) => {
        if (line.text === own.text) roots.add(k);
      });
    } catch {
      // A target that can't be resolved here touches nothing.
    }
  }
  return { lines, touched: subtrees(lines, [...roots]) };
}
