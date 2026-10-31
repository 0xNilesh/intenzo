// The Cloud's own uploads to the private Blob store (§28): the context bundle and the ticket's
// recording (§8). The worker uploads its takes itself, through presigned URLs (upload-tokens.ts).
// vercel.com/docs/vercel-blob (private stores)
import type { ArtifactRef } from "@intenzo/core";
import { put } from "@vercel/blob";

import type { BlobAuth } from "../env.ts";

export type PrivatePut = (
  path: string,
  body: Uint8Array | string,
  contentType: string,
) => Promise<ArtifactRef>;

export function privatePut(auth: BlobAuth | null): PrivatePut {
  return async (path, body, contentType) => {
    if (!auth) throw new Error("no private Blob store is configured");
    const bytes =
      typeof body === "string"
        ? Buffer.from(body)
        : Buffer.from(body.buffer, body.byteOffset, body.byteLength);
    await put(path, bytes, {
      access: "private",
      contentType,
      // A respawned job's bundle replaces the first's, at the run's own path.
      addRandomSuffix: false,
      allowOverwrite: true,
      ...auth,
    });
    return { store: "private", path, contentType, bytes: bytes.byteLength };
  };
}
