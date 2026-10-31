// GET /api/worker/alive (§12): 200 while the job is its run's current one, 410 once it isn't. The
// logic is handleAlive() in src/jobs/worker-api.ts.
import { cloud } from "../../../../cloud.ts";
import { handleAlive } from "../../../../jobs/worker-api.ts";

export async function GET(request: Request): Promise<Response> {
  const { env, ...deps } = cloud();
  return handleAlive(request, { ...deps, secret: env.INTENZO_JOB_SECRET });
}
