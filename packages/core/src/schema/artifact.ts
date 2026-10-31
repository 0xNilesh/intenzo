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

/**
 * §28: where one file of one take lives in a Blob store. Every recording is a new take, so a
 * re-record never overwrites the take a verdict cites; uploads refuse to overwrite as well.
 */
export function takePath(
  runId: string,
  criterionId: string,
  side: "pr" | "base",
  take: number,
  file: string,
): string {
  if (!Number.isInteger(take) || take < 1) throw new Error(`take must be 1 or more, not ${take}`);
  if (!/^[\w.-]+$/.test(file)) throw new Error(`not a plain file name: ${file}`);
  return `runs/${runId}/${criterionId}/${side}/take-${take}/${file}`;
}
