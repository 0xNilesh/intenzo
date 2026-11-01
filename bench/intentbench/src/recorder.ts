// IntentBench's "record once" (§31, T6.2): for every criterion of every case, explore the case's
// preview once, then record two PR takes and one base take along the path it found, into a pack.
// A criterion that already has a pack is skipped, so a rerun records only what's missing; one
// that crashes leaves no pack, so the next run tries it again. The browser and the models sit
// behind a Lab, so tests run it with a fake one.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Criterion, SavedPath } from "@intenzo/core";
import { costUsd } from "@intenzo/core/models";
import { type ExploreResult, NAVIGATOR_MODEL } from "@intenzo/core/navigator";

import { type BenchCase, loadTicket } from "./case.ts";
import type { BenchDiff } from "./github.ts";
import { diffFile, missingPacks, Pack, packDir, readDiff, type Take } from "./pack.ts";

export interface Lab {
  explore(input: { origin: string; criterion: Criterion }): Promise<ExploreResult>;
  /** Records one take into `outDir`, keeping only the files the take names. */
  record(input: {
    origin: string;
    side: "pr" | "base";
    criterion: Criterion;
    path: SavedPath;
    outDir: string;
  }): Promise<Take>;
  /** What the case's branch changes since the base. */
  diff(branch: string): Promise<BenchDiff>;
}

export interface RecordOptions {
  dir: string;
  lab: Lab;
  /** The case's preview; null when it has none (the case is skipped). */
  originOf: (c: BenchCase) => string | null;
  baseOrigin: string;
  log: (line: string) => void;
  /** Replaces every secret in a text before it's logged or written. */
  redact?: (text: string) => string;
  /** Criteria recorded at once. */
  concurrency?: number;
  now?: () => Date;
}

export interface RecordSummary {
  recorded: number;
  skipped: number;
  /** Criteria that crashed: no pack, so a rerun tries them again. */
  crashed: string[];
  costUsd: number;
}

/** Records every missing pack (and diff) of these cases. */
export async function recordAll(
  cases: readonly BenchCase[],
  options: RecordOptions,
): Promise<RecordSummary> {
  const { dir, lab, log } = options;
  const redact = options.redact ?? ((text: string) => text);
  const now = options.now ?? (() => new Date());

  for (const c of cases) {
    if (readDiff(dir, c.id)) continue;
    mkdirSync(join(dir, c.id), { recursive: true });
    const diff = await lab.diff(c.branch);
    writeFileSync(diffFile(dir, c.id), `${redact(JSON.stringify(diff, null, 1))}\n`);
  }

  const wanted = cases.flatMap((c) =>
    loadTicket(c.ticket).criteria.map((criterion) => ({
      c,
      criterion,
      caseId: c.id,
      criterionId: criterion.id,
    })),
  );
  const todo = missingPacks(dir, wanted);
  log(`${wanted.length - todo.length} packs already recorded, ${todo.length} to record`);

  let spent = 0;
  const crashed: string[] = [];
  const one = async ({ c, criterion }: (typeof todo)[number]) => {
    const name = `${c.id} ${criterion.id}`;
    const origin = options.originOf(c);
    if (!origin) {
      crashed.push(name);
      log(`${name}: no preview, not recorded`);
      return;
    }
    const out = packDir(dir, c.id, criterion.id);
    // A crashed run's leftovers go: a pack is written whole or not at all.
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    try {
      const explored = await lab.explore({ origin, criterion });
      const cost = costUsd(NAVIGATOR_MODEL, explored.usage) ?? 0;
      spent += cost;
      const head = {
        caseId: c.id,
        criterionId: criterion.id,
        recordedAt: now().toISOString(),
        origin,
        baseOrigin: options.baseOrigin,
        explore: {
          status: explored.status,
          reason: explored.status === "found" ? null : explored.reason,
          modelCalls: explored.modelCalls,
          ms: explored.ms,
          costUsd: cost,
        },
      };
      let pack: Pack;
      if (explored.status !== "found") {
        pack = { ...head, path: null, takes: null };
        log(redact(`${name}: ${explored.status}: ${explored.reason}`).slice(0, 300));
      } else {
        // In turn, not at once: the takes are timed recordings (§21).
        const take = (side: "pr" | "base", folder: string, from: string) =>
          lab.record({
            origin: from,
            side,
            criterion,
            path: explored.path,
            outDir: join(out, folder),
          });
        const pr1 = await take("pr", "pr-1", origin);
        const pr2 = await take("pr", "pr-2", origin);
        const base = await take("base", "base", options.baseOrigin);
        pack = { ...head, path: explored.path, takes: { pr: [pr1, pr2], base } };
        log(
          `${name}: found in ${explored.modelCalls} calls; PR ${pr1.lane.status}, ${pr2.lane.status}; base ${base.lane.status}`,
        );
      }
      const checked = Pack.parse(JSON.parse(redact(JSON.stringify(pack))));
      writeFileSync(join(out, "pack.json"), `${JSON.stringify(checked, null, 1)}\n`);
    } catch (err) {
      crashed.push(name);
      rmSync(out, { recursive: true, force: true });
      log(redact(`${name}: crashed, not recorded: ${(err as Error).message}`).slice(0, 300));
    }
  };

  // A small pool: each criterion explores, then records its takes.
  const queue = [...todo];
  const workers = Array.from({ length: Math.max(1, options.concurrency ?? 2) }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) await one(next);
  });
  await Promise.all(workers);
  return {
    recorded: todo.length - crashed.length,
    skipped: wanted.length - todo.length,
    crashed,
    costUsd: spent,
  };
}
