import { randomUUID } from "node:crypto";

import type { Browser, BrowserContext, Page } from "playwright";

import { hookHeaders } from "./hooks.ts";

// A lane is one browser context for one execution on one side (ARCHITECTURE §21.1–§21.2): its own
// cookies and identity, the Vercel bypass as a host-only cookie, and a main-frame allowlist.

export const VIEWPORT = { width: 1280, height: 720 } as const;

export interface LaneOptions {
  /** The app under test: the PR preview or the merge-base preview. */
  origin: string;
  /** Extra origins the main frame may navigate to, e.g. an auth provider. */
  allowedNavigationOrigins?: readonly string[];
  /** Vercel deployment-protection bypass secret, when the deployment is protected. */
  bypass?: string;
  /** Record the lane's video here (omit for unrecorded runs such as exploration). */
  videoDir?: string;
  /** Write a Playwright trace here when the lane closes. */
  tracePath?: string;
}

export interface Lane {
  context: BrowserContext;
  page: Page;
  origin: string;
  /** Off-origin main-frame navigations that were aborted before any request left. */
  blockedNavigations: string[];
  /** Off-origin pages the main frame still reached (e.g. through a redirect). Any → fail the lane. */
  offOriginNavigations: string[];
  close(): Promise<{ videoPath: string | null; tracePath: string | null }>;
}

export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "null";
  }
}

/** Opens a lane. No secret header is ever attached to a browser request (§21.2). */
export async function openLane(browser: Browser, options: LaneOptions): Promise<Lane> {
  const origin = originOf(options.origin);
  if (origin === "null") throw new Error(`lane origin must be an absolute URL: ${options.origin}`);
  const allowed = new Set([origin, ...(options.allowedNavigationOrigins ?? []).map(originOf)]);

  const context = await browser.newContext({
    viewport: VIEWPORT,
    locale: "en-US",
    timezoneId: "UTC",
    // Every request must pass through routing; a service worker could bypass it.
    serviceWorkers: "block",
    ...(options.videoDir && { recordVideo: { dir: options.videoDir, size: VIEWPORT } }),
  });

  try {
    if (options.bypass) await obtainBypassCookie(context, origin, options.bypass);
    if (options.tracePath) await context.tracing.start({ screenshots: true, snapshots: true });

    const blockedNavigations: string[] = [];
    await context.route("**/*", (route, request) => {
      const mainFrame = request.isNavigationRequest() && request.frame().parentFrame() === null;
      if (mainFrame && !allowed.has(originOf(request.url()))) {
        blockedNavigations.push(request.url());
        // "aborted" cancels the navigation and leaves the page where it was; any other error code
        // makes Chromium commit an error page, which would strand the agent.
        return route.abort("aborted");
      }
      return route.continue();
    });

    const page = await context.newPage();
    // Routing only sees a redirect chain's first URL, so watch where the main frame actually lands.
    const offOriginNavigations: string[] = [];
    page.on("framenavigated", (frame) => {
      const url = frame.url();
      // Blank pages and Chromium's own error pages aren't off-origin sites.
      const browserPage = url === "about:blank" || url.startsWith("chrome-error://");
      if (frame === page.mainFrame() && !browserPage && !allowed.has(originOf(url))) {
        offOriginNavigations.push(url);
      }
    });

    return {
      context,
      page,
      origin,
      blockedNavigations,
      offOriginNavigations,
      async close() {
        let tracePath: string | null = null;
        if (options.tracePath) {
          await context.tracing.stop({ path: options.tracePath });
          tracePath = options.tracePath;
        }
        const video = page.video();
        await context.close();
        return { videoPath: video ? await video.path() : null, tracePath };
      },
    };
  } catch (err) {
    await context.close();
    throw err;
  }
}

/**
 * Exchanges the bypass secret for Vercel's host-only bypass cookie with one direct request that
 * never follows a redirect, so the secret can't travel anywhere but the lane's own origin.
 */
async function obtainBypassCookie(
  context: BrowserContext,
  origin: string,
  secret: string,
): Promise<void> {
  const res = await context.request.get(`${origin}/`, {
    headers: { "x-vercel-protection-bypass": secret, "x-vercel-set-bypass-cookie": "true" },
    maxRedirects: 0,
    failOnStatusCode: false,
  });
  if (res.status() === 401 || res.status() === 403) {
    throw new Error(`the deployment rejected the protection bypass (HTTP ${res.status()})`);
  }
}

export class HookError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "HookError";
    this.status = status;
  }
}

export interface IdentityOptions {
  /** The session hook's path on the lane's origin, e.g. "/api/test/session". */
  hookPath: string;
  /** The repo's hook secret (decrypted just in time, never logged). */
  secret: string;
  nonce?: string;
}

/**
 * Asks the app's session hook for a brand-new user and keeps its session cookie in the lane
 * (ARCHITECTURE §21.1, ephemeral_user). Returns the hook's name for the user.
 */
export async function acquireIdentity(lane: Lane, options: IdentityOptions): Promise<string> {
  const body = JSON.stringify({ nonce: options.nonce ?? randomUUID() });
  const url = new URL(options.hookPath, lane.origin);
  if (url.origin !== lane.origin) throw new Error(`session hook must be on ${lane.origin}`);
  const res = await lane.context.request.post(url.href, {
    data: body,
    headers: hookHeaders(options.secret, body),
    maxRedirects: 0,
    failOnStatusCode: false,
  });
  if (res.status() === 403) {
    throw new HookError("the session hook refused: test hooks are disabled in production", 403);
  }
  if (!res.ok()) {
    const detail = (await res.text()).slice(0, 200);
    throw new HookError(`the session hook answered ${res.status()}: ${detail}`, res.status());
  }
  const shopper = ((await res.json()) as { shopper?: unknown }).shopper;
  if (typeof shopper !== "string" || shopper === "") {
    throw new HookError('the session hook answered without a "shopper"', res.status());
  }
  return shopper;
}
