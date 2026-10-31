// POST /api/internal/sweep (§12): the minute tick from Modal's cron. The logic is handleSweep() in
// src/runs/sweep.ts.
import { cloud } from "../../../../cloud.ts";
import { handleSweep } from "../../../../runs/sweep.ts";

export async function POST(request: Request): Promise<Response> {
  const { env, ...deps } = cloud();
  return handleSweep(request, { ...deps, secret: env.INTENZO_SWEEP_SECRET });
}
