import type { Page } from "playwright";

// The canonical clock (ARCHITECTURE §21.4): epoch milliseconds, computed the same way in Node and in
// the page. They share a host, so the two agree to under a millisecond, and navigations don't
// reset it. Every step, reading and box sample is stamped with it.

export function now(): number {
  return performance.timeOrigin + performance.now();
}

export function pageNow(page: Page): Promise<number> {
  return page.evaluate(() => performance.timeOrigin + performance.now());
}

export const MARKER_MS = 300;

/**
 * Covers the viewport in solid #00FF00 for 300 ms, then removes it. Returns the canonical time
 * the marker was first painted (after two animation frames), which is what video alignment needs.
 */
export async function showSyncMarker(page: Page): Promise<number> {
  return page.evaluate(
    (durationMs) =>
      new Promise<number>((resolve) => {
        const marker = document.createElement("div");
        marker.setAttribute("data-intenzo-marker", "");
        marker.style.cssText =
          "position:fixed;inset:0;background:#00FF00;z-index:2147483647;pointer-events:none";
        document.documentElement.append(marker);
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const shownAt = performance.timeOrigin + performance.now();
            setTimeout(() => {
              marker.remove();
              resolve(shownAt);
            }, durationMs);
          }),
        );
      }),
    MARKER_MS,
  );
}
