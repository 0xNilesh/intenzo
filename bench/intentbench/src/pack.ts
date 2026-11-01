// IntentBench's evidence packs (ARCHITECTURE §31, T6.2): what each criterion of each case looked
// like, recorded once and frozen, so the judging arms (T6.3) all read the same evidence. A pack is
// the explored path and three takes: two of the PR side (for §19 step e's re-record rule) and one
// of the base. Exploration that fails is kept as setup_failed, never dropped.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { CriterionId, LaneResult, SavedPath } from "@intenzo/core";
import { z } from "zod";

import type { BenchCase } from "./case.ts";
import { BenchDiff } from "./github.ts";

/** Where packs live: local and gitignored, since they hold videos. */
export const PACKS_DIR = new URL("../packs/", import.meta.url).pathname;
/** What was recorded, without the videos: committed. */
export const MANIFEST_FILE = new URL("../manifest.json", import.meta.url).pathname;

export const Take = z.strictObject({
  /** The lane as the recorder returned it, secrets redacted. */
  lane: LaneResult,
  /** Files in the take's folder; null when the video couldn't be made (§21.4). */
  judgeVideo: z.string().nullable(),
  humanVideo: z.string().nullable(),
  annotatedShot: z.string().nullable(),
  /** file ms = canonical ms + offset (§21.4). */
  offsets: z.strictObject({ human: z.number(), judge: z.number() }).nullable(),
});
export type Take = z.infer<typeof Take>;

export const Pack = z
  .strictObject({
    caseId: z.string(),
    criterionId: CriterionId,
    recordedAt: z.iso.datetime(),
    /** The case's preview, and the base's. */
    origin: z.url(),
    baseOrigin: z.url(),
    explore: z.strictObject({
      status: z.enum(["found", "setup_failed", "trigger_absent"]),
      reason: z.string().nullable(),
      modelCalls: z.number().int().nonnegative(),
      ms: z.number().nonnegative(),
      costUsd: z.number().nonnegative(),
    }),
    path: SavedPath.nullable(),
    /** Null when exploring found no way to the trigger: the case's row says setup_failed. */
    takes: z.strictObject({ pr: z.tuple([Take, Take]), base: Take }).nullable(),
  })
  .superRefine((p, ctx) => {
    const found = p.explore.status === "found";
    if (found !== (p.path !== null) || found !== (p.takes !== null))
      ctx.addIssue({
        code: "custom",
        message: "a found path has takes; a failed explore has none",
      });
    if (p.path && p.path.criterionId !== p.criterionId)
      ctx.addIssue({ code: "custom", message: `the path is for ${p.path.criterionId}` });
  });
export type Pack = z.infer<typeof Pack>;

export const packDir = (dir: string, caseId: string, criterionId: string) =>
  join(dir, caseId, criterionId);
export const diffFile = (dir: string, caseId: string) => join(dir, caseId, "diff.json");

/** The pack of one criterion, or null when it hasn't been recorded. */
export function readPack(dir: string, caseId: string, criterionId: string): Pack | null {
  const file = join(packDir(dir, caseId, criterionId), "pack.json");
  return existsSync(file) ? Pack.parse(JSON.parse(readFileSync(file, "utf8"))) : null;
}

export function readDiff(dir: string, caseId: string): BenchDiff | null {
  const file = diffFile(dir, caseId);
  return existsSync(file) ? BenchDiff.parse(JSON.parse(readFileSync(file, "utf8"))) : null;
}

/** The criteria of these cases that have no pack yet: a rerun records only these. */
export function missingPacks<T extends { caseId: string; criterionId: string }>(
  dir: string,
  wanted: readonly T[],
): T[] {
  return wanted.filter(
    (w) => !existsSync(join(packDir(dir, w.caseId, w.criterionId), "pack.json")),
  );
}

/** sha256 over a folder's files, names included: it changes when any file does. */
export function folderHash(folder: string): string {
  const hash = createHash("sha256");
  const files = readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name))
    .sort();
  for (const file of files) {
    hash.update(`${relative(folder, file)}\0`);
    hash.update(readFileSync(file));
  }
  return hash.digest("hex");
}

export interface ManifestRow {
  case: string;
  criterion: string;
  explore: Pack["explore"]["status"];
  calls: number;
  usd: number;
  /** Each take's lane status: two PR takes, then the base. */
  pr: string[] | null;
  base: string | null;
  sha256: string;
}

export interface Manifest {
  baseSha: string;
  /** Each case's commit, from its diff. */
  heads: Record<string, string | null>;
  rows: ManifestRow[];
  missing: string[];
  exploreUsd: number;
}

/** What's in the packs folder for these cases, small enough to commit. */
export function manifestOf(dir: string, cases: readonly BenchCase[], baseSha: string): Manifest {
  const rows: ManifestRow[] = [];
  const missing: string[] = [];
  const heads: Record<string, string | null> = {};
  for (const c of cases) {
    heads[c.id] = readDiff(dir, c.id)?.head ?? null;
    for (const criterionId of Object.keys(c.labels)) {
      const pack = readPack(dir, c.id, criterionId);
      if (!pack) {
        missing.push(`${c.id}/${criterionId}`);
        continue;
      }
      rows.push({
        case: c.id,
        criterion: criterionId,
        explore: pack.explore.status,
        calls: pack.explore.modelCalls,
        usd: Math.round(pack.explore.costUsd * 1e5) / 1e5,
        pr: pack.takes?.pr.map((t) => t.lane.status) ?? null,
        base: pack.takes?.base.lane.status ?? null,
        sha256: folderHash(packDir(dir, c.id, criterionId)),
      });
    }
  }
  const exploreUsd = Math.round(rows.reduce((sum, r) => sum + r.usd, 0) * 1e4) / 1e4;
  return { baseSha, heads, rows, missing, exploreUsd };
}

/** One row per line, so a rerun's diff shows which packs changed. */
export function formatManifest(m: Manifest): string {
  const rows = m.rows.map((r) => `    ${JSON.stringify(r)}`).join(",\n");
  return [
    "{",
    `  "baseSha": ${JSON.stringify(m.baseSha)},`,
    `  "heads": ${JSON.stringify(m.heads, null, 2).replace(/\n/g, "\n  ")},`,
    `  "rows": [\n${rows}\n  ],`,
    `  "missing": ${JSON.stringify(m.missing)},`,
    `  "exploreUsd": ${m.exploreUsd}`,
    "}",
    "",
  ].join("\n");
}
