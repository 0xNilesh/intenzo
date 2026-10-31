// Uploading a job's files (§28): the Cloud presigns one URL per file, for its exact path under the
// job's run, and the worker PUTs the bytes straight to Blob. The URL refuses to overwrite, so each
// take keeps its own files.
import type { ArtifactRef } from "@intenzo/core";

import type { JobClient, UploadRequest } from "./client.ts";

export interface FileToUpload extends UploadRequest {
  /** Backed by a plain ArrayBuffer, as fetch() requires (a Buffer from fs.readFile is). */
  body: Uint8Array<ArrayBuffer>;
}

export async function uploadArtifacts(
  client: JobClient,
  files: readonly FileToUpload[],
): Promise<ArtifactRef[]> {
  const uploads = await client.uploadUrls(
    files.map(({ store, path, contentType }) => ({ store, path, contentType })),
  );
  return Promise.all(
    files.map(async (file, i) => {
      const upload = uploads[i];
      if (upload?.path !== file.path) throw new Error(`no upload URL for ${file.path}`);
      const response = await fetch(upload.uploadUrl, {
        method: "PUT",
        headers: { "content-type": file.contentType },
        body: file.body,
        signal: AbortSignal.timeout(300_000),
      });
      if (!response.ok) {
        const why = (await response.text().catch(() => "")).slice(0, 200);
        throw new Error(`uploading ${file.path}: ${response.status} ${why}`.trim());
      }
      return {
        store: file.store,
        path: file.path,
        contentType: file.contentType,
        bytes: file.body.byteLength,
      };
    }),
  );
}
