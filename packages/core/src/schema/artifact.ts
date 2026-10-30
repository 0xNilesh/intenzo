import { z } from "zod";

/**
 * A stored file (clip, GIF, trace, bundle): which Blob store and where in it (ARCHITECTURE §28).
 * Recordings live at `runs/{runId}/{criterion}/{side}/take-{n}/{file}`.
 */
export const ArtifactRef = z.object({
  store: z.enum(["public", "private"]),
  path: z
    .string()
    .min(1)
    .refine((p) => !p.startsWith("/") && !p.split("/").includes(".."), {
      message: "must be a relative path inside the store",
    }),
  contentType: z.string().min(1),
  bytes: z.number().int().nonnegative().optional(),
});
export type ArtifactRef = z.infer<typeof ArtifactRef>;
