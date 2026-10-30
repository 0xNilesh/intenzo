import { setTimeout as sleep } from "node:timers/promises";

import type { BrowserContext, Page, Request } from "playwright";

import { now } from "./clock.ts";
import { originOf } from "./lane.ts";

// settle() (ARCHITECTURE §20.3.1): wait until the page is quiet, capped at 2 s. Quiet means both
//   - no DOM mutation for 300 ms (a MutationObserver injected through addInitScript, so it's on
//     every document from its first moment), and
//   - no pending document, XHR or fetch request to the lane's own origin.
// Third-party requests, WebSockets, EventSource and beacons never count: an analytics ping or a
// live-reload socket would otherwise keep a page "busy" forever. Intenzo's own DOM writes (the sync
// marker, the navigator's element ids) don't count either.

export const QUIET_MS = 300;
export const SETTLE_CAP_MS = 2000;
const POLL_MS = 25;

/** The resource types a page waits on. Beacons are "ping"; WebSockets and EventSource never qualify. */
const WAITED_ON = new Set(["document", "xhr", "fetch"]);
const LAST_MUTATION = "__intenzoLastMutation";

export interface Settled {
  /** False when the 2 s cap ran out first. */
  settled: boolean;
  /** How long settle() took. */
  ms: number;
}

export interface SettleOptions {
  quietMs?: number;
  capMs?: number;
}

export class Settler {
  readonly #pending = new Set<Request>();

  /**
   * Starts watching a lane: the mutation observer goes on every document the context loads from
   * now on, and its same-origin requests are counted while they're in flight. Install it before
   * the lane's first navigation.
   */
  static async install(context: BrowserContext, origin: string): Promise<Settler> {
    const settler = new Settler();
    const laneOrigin = originOf(origin);
    await context.addInitScript(observeMutations, LAST_MUTATION);
    context.on("request", (request) => {
      if (WAITED_ON.has(request.resourceType()) && originOf(request.url()) === laneOrigin) {
        settler.#pending.add(request);
      }
    });
    const done = (request: Request) => settler.#pending.delete(request);
    context.on("requestfinished", done);
    context.on("requestfailed", done);
    return settler;
  }

  /** Same-origin document/XHR/fetch requests still in flight. */
  get pending(): number {
    return this.#pending.size;
  }

  /**
   * Waits until the page is quiet (§20.3.1), or the cap runs out. Never throws. The quiet window
   * starts no earlier than the call: an action's effects (a fetch it starts, a re-render) can reach
   * Node a moment after the action resolves, so a page is never taken as quiet on old evidence.
   */
  async settle(page: Page, options: SettleOptions = {}): Promise<Settled> {
    const quietMs = options.quietMs ?? QUIET_MS;
    const capMs = options.capMs ?? SETTLE_CAP_MS;
    const start = now();
    for (;;) {
      const t = now();
      const quietSince = Math.max(start, await lastMutation(page, t));
      if (this.#pending.size === 0 && t - quietSince >= quietMs) {
        return { settled: true, ms: Math.round(now() - start) };
      }
      if (t - start >= capMs) return { settled: false, ms: Math.round(now() - start) };
      await sleep(POLL_MS);
    }
  }
}

/** The canonical time of the page's last DOM mutation. A page mid-navigation counts as mutating. */
async function lastMutation(page: Page, fallback: number): Promise<number> {
  try {
    const at = await page.evaluate(
      (key) => (window as unknown as Record<string, number | undefined>)[key],
      LAST_MUTATION,
    );
    return typeof at === "number" ? at : fallback;
  } catch {
    return fallback; // the document is being replaced
  }
}

/** Runs in the page, once per document. Self-contained: it can't reach anything in this module. */
function observeMutations(key: string): void {
  if (window.top !== window) return; // main frame only
  const w = window as unknown as Record<string, number>;
  const stamp = () => performance.timeOrigin + performance.now();
  // A new document has just changed everything.
  w[key] = stamp();

  const OURS = "[data-intenzo-marker]";
  const ours = (node: Node | null): boolean =>
    node instanceof Element ? node.matches(OURS) || node.closest(OURS) !== null : false;
  const intenzoOnly = (record: MutationRecord): boolean => {
    if (record.type === "attributes") {
      const name = record.attributeName ?? "";
      if (name === "data-iz-ref" || name === "data-intenzo-marker") return true;
    }
    if (ours(record.target)) return true;
    if (record.type !== "childList") return false;
    const nodes = [...record.addedNodes, ...record.removedNodes];
    return nodes.length > 0 && nodes.every(ours);
  };

  new MutationObserver((records) => {
    if (!records.every(intenzoOnly)) w[key] = stamp();
  }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
}
