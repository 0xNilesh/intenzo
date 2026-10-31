// POST /api/worker/events (§9, §12): a worker's report on its job. The logic is handleWorkerEvent()
// in src/jobs/worker-api.ts.
import { cloud } from "../../../../cloud.ts";
import { handleWorkerEvent } from "../../../../jobs/worker-api.ts";

export async function POST(request: Request): Promise<Response> {
  const { env, ...deps } = cloud();
  return handleWorkerEvent(request, { ...deps, secret: env.INTENZO_JOB_SECRET });
}
