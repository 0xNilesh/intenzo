// POST /api/worker/upload-tokens (§28): presigned upload URLs for the job's files. The logic is
// handleUploadTokens() in src/artifacts/upload-tokens.ts.
import { blobSigner, handleUploadTokens } from "../../../../artifacts/upload-tokens.ts";
import { cloud } from "../../../../cloud.ts";
import { blobStores } from "../../../../env.ts";

export async function POST(request: Request): Promise<Response> {
  const { env, db, now } = cloud();
  return handleUploadTokens(request, {
    db,
    now,
    secret: env.INTENZO_JOB_SECRET,
    sign: blobSigner(blobStores(env)),
  });
}
