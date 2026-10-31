// Where an artifact can be read (§28): a public blob at its public URL, a private one at a signed
// GET URL valid for an hour. vercel.com/docs/vercel-blob/vercel-signed-urls
import type { ArtifactRef } from "@intenzo/core";
import { issueSignedToken, presignUrl } from "@vercel/blob";

import type { BlobAuth } from "../env.ts";

/** How long a signed read URL works: long enough to watch, short enough not to be shared on. */
export const READ_URL_TTL_MS = 60 * 60_000;

export type ArtifactUrl = (ref: ArtifactRef) => Promise<string | null>;

/** A store's id from its connection: the id itself, or the one inside a read-write token. */
export function storeIdOf(auth: BlobAuth): string {
  const id = "storeId" in auth ? auth.storeId : (auth.token.split("_")[3] ?? "");
  return id.replace(/^store_/, "");
}

/** Public blobs live at https://{store id, lowercased}.public.blob.vercel-storage.com/{path}. */
export function publicUrl(auth: BlobAuth, path: string): string {
  return `https://${storeIdOf(auth).toLowerCase()}.public.blob.vercel-storage.com/${path}`;
}

export function artifactUrls(
  stores: { public: BlobAuth | null; private: BlobAuth | null },
  now: () => number = Date.now,
): ArtifactUrl {
  return async (ref) => {
    const auth = stores[ref.store];
    if (!auth) return null;
    if (ref.store === "public") return publicUrl(auth, ref.path);
    const validUntil = now() + READ_URL_TTL_MS;
    const token = await issueSignedToken({
      ...auth,
      pathname: ref.path,
      operations: ["get"],
      validUntil,
    });
    const { presignedUrl } = await presignUrl(token, {
      operation: "get",
      pathname: ref.path,
      access: "private",
      validUntil,
    });
    return presignedUrl;
  };
}
