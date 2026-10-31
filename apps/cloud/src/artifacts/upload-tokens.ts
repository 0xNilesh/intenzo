// POST /api/worker/upload-tokens (§28): presigned upload URLs for a job's files, each for one exact
// path under runs/{runId}/ of the job's own run. The worker PUTs each file straight to Blob, so
// videos never pass through a Vercel function, and it never holds a Blob token.
import { issueSignedToken, presignUrl } from "@vercel/blob";
import { z } from "zod";

import type { BlobAuth } from "../env.ts";
import { authorizeJob, isCurrentJob, type WorkerApiDeps } from "../jobs/worker-api.ts";

export type StoreName = "public" | "private";

/**
 * What each store takes (§28): GIFs and stills go public (GitHub's image proxy fetches them);
 * videos, traces and bundles stay private.
 */
export const STORE_RULES: Record<StoreName, { contentTypes: string[]; maxBytes: number }> = {
  public: { contentTypes: ["image/gif", "image/png", "image/webp", "image/jpeg"], maxBytes: 20e6 },
  private: {
    contentTypes: [
      "video/mp4",
      "video/webm",
      "image/gif",
      "image/png",
      "image/jpeg",
      "application/zip",
      "application/json",
    ],
    maxBytes: 500e6,
  },
};

/** How long an upload URL stays valid. */
export const UPLOAD_URL_TTL_MS = 15 * 60_000;

export interface FileToSign {
  store: StoreName;
  path: string;
  contentType: string;
  maxBytes: number;
}

/** Makes one presigned PUT URL. The real one is blobSigner(); tests pass a fake. */
export type UploadSigner = (file: FileToSign, validUntil: number) => Promise<string>;

const UploadRequest = z.object({
  files: z
    .array(
      z.object({
        store: z.enum(["public", "private"]),
        path: z.string().min(1).max(500),
        contentType: z.string().min(1),
      }),
    )
    .min(1)
    .max(20),
});

/** The path is a plain relative path inside runs/{runId}/: no "..", no empty or odd segments. */
export function insideRun(path: string, runId: string): boolean {
  return (
    path.startsWith(`runs/${runId}/`) &&
    /^[\w./-]+$/.test(path) &&
    path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

const reply = (status: number, body: object) => Response.json(body, { status });

export async function handleUploadTokens(
  request: Request,
  deps: Pick<WorkerApiDeps, "db" | "secret" | "now"> & { sign: UploadSigner },
): Promise<Response> {
  const auth = await authorizeJob(request, deps);
  if (auth instanceof Response) return auth;
  const { claims, run } = auth;
  if (!isCurrentJob(run, claims.jobId)) {
    return reply(410, { error: "this job isn't current any more: stop" });
  }

  let files: z.infer<typeof UploadRequest>["files"];
  try {
    files = UploadRequest.parse(await request.json()).files;
  } catch {
    return reply(400, {
      error: "expected { files: [{ store, path, contentType }] }, 1 to 20 of them",
    });
  }
  for (const file of files) {
    if (!insideRun(file.path, claims.runId)) {
      return reply(403, { error: `${file.path} isn't a path under runs/${claims.runId}/` });
    }
    if (!STORE_RULES[file.store].contentTypes.includes(file.contentType)) {
      return reply(403, { error: `the ${file.store} store doesn't take ${file.contentType}` });
    }
  }

  const validUntil = deps.now().getTime() + UPLOAD_URL_TTL_MS;
  const uploads = await Promise.all(
    files.map(async (file) => ({
      ...file,
      uploadUrl: await deps.sign(
        { ...file, maxBytes: STORE_RULES[file.store].maxBytes },
        validUntil,
      ),
      validUntil: new Date(validUntil).toISOString(),
    })),
  );
  return reply(200, { uploads });
}

/**
 * The real signer: a signed token scoped to the one path and to PUT, then a presigned URL that
 * refuses to overwrite, so a second take can't replace the first. vercel.com/docs/vercel-blob/vercel-signed-urls
 */
export function blobSigner(stores: Record<StoreName, BlobAuth | null>): UploadSigner {
  return async (file, validUntil) => {
    const auth = stores[file.store];
    if (!auth) throw new Error(`no ${file.store} Blob store is configured`);
    const constraints = {
      allowedContentTypes: [file.contentType],
      maximumSizeInBytes: file.maxBytes,
    };
    const token = await issueSignedToken({
      ...auth,
      pathname: file.path,
      operations: ["put"],
      validUntil,
      ...constraints,
    });
    const { presignedUrl } = await presignUrl(token, {
      operation: "put",
      pathname: file.path,
      access: file.store,
      validUntil,
      allowOverwrite: false,
      addRandomSuffix: false,
      ...constraints,
    });
    return presignedUrl;
  };
}
