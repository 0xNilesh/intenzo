import type { SavedPath, Target } from "../schema/index.ts";

// §24's plan for one run: whether to look for unrequested changes at all, on which routes, and
// which targets the criteria touch there.

/** §24 (hackathon): at most this many routes per run. */
export const MAX_ROUTES = 2;

/** Why change detection is skipped, or null to run it (§24, §17.3). */
export function skipChanges(job: {
  baseUrl: string | null;
  baseDrift?: number | null;
  /** The base side gets a fresh identity of its own (a session hook). */
  baseIsolated: boolean;
}): string | null {
  if (job.baseUrl === null) return "no baseline";
  if (!job.baseIsolated) return "the base side isn't isolated";
  if ((job.baseDrift ?? 0) > 0)
    return `the baseline is ${job.baseDrift} commits before the merge base`;
  return null;
}

/** A path segment that looks like an id one lane made: a uuid, a long hex or a long number. */
const EPHEMERAL = /^([0-9a-f]{8,}(-[0-9a-f]{4,})*|\d{4,})$/i;

/**
 * The routes the criteria act on: each path's first goto, else the repo's start route, then the
 * coverage map's routes; without ephemeral ids, at most MAX_ROUTES.
 */
export function changeRoutes(
  paths: readonly SavedPath[],
  coverageRoutes: readonly string[],
  startRoute: string,
): string[] {
  const first = (path: SavedPath) =>
    [...path.setup, ...path.trigger].find((s) => s.op === "goto") as { path: string } | undefined;
  const routes = [...paths.map((p) => first(p)?.path ?? startRoute), ...coverageRoutes]
    .map((r) => r.split(/[?#]/)[0]!)
    .filter((r) => r.startsWith("/") && !r.split("/").some((part) => EPHEMERAL.test(part)));
  // No path and no mapped route: the repo's start route is where the PR shows.
  return routes.length > 0 ? [...new Set(routes)].slice(0, MAX_ROUTES) : [startRoute];
}

/** What the criteria touch (§24): their trigger steps' targets and their watched elements. */
export function changeTargets(paths: readonly SavedPath[]): Target[] {
  return paths.flatMap((path) => [
    ...path.trigger.flatMap((s) => ("target" in s && s.target ? [s.target as Target] : [])),
    ...path.watch.filter((w) => w.scope === "element").map((w) => w.target),
  ]);
}
