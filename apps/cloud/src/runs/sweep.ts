// POST /api/internal/sweep (§12): the minute tick. It applies the deadlines (§16.1: a preview that
// never came, a job that ran too long) and drains the outbox's retries, for when no event arrives
// to do it. Modal's cron calls it every minute (modal/app.py) with INTENZO_SWEEP_SECRET.
import { timingSafeEqual } from "node:crypto";

import { ne } from "drizzle-orm";

import type { Db } from "../db/db.ts";
import { runs } from "../db/schema.ts";
import { bearerToken } from "../jobs/token.ts";
import { advance } from "./advance.ts";

export interface SweepDeps {
  db: Db;
  /** INTENZO_SWEEP_SECRET; without it the route refuses everyone. */
  secret: string | undefined;
  now: () => Date;
  newRunId: () => string;
  drain: () => Promise<unknown>;
  log: (line: string) => void;
}

const reply = (status: number, body: object) => Response.json(body, { status });

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function handleSweep(request: Request, deps: SweepDeps): Promise<Response> {
  if (!deps.secret) return reply(503, { error: "INTENZO_SWEEP_SECRET isn't set" });
  const token = bearerToken(request);
  if (!token || !sameSecret(token, deps.secret)) return reply(401, { error: "wrong sweep secret" });

  const groups = await deps.db
    .selectDistinct({ id: runs.runGroupId })
    .from(runs)
    .where(ne(runs.state, "done"));
  let changed = 0;
  for (const { id } of groups) {
    const decision = await advance(
      deps.db,
      id,
      { kind: "tick" },
      {
        now: deps.now(),
        newRunId: deps.newRunId,
      },
    );
    if (decision.created.length + decision.updated.length > 0) changed += 1;
  }
  const drained = await deps.drain();
  if (changed > 0) deps.log(`sweep: ${changed} of ${groups.length} open run groups changed`);
  return reply(200, { groups: groups.length, changed, drained });
}
