import { z } from "zod";

/** Every model T0.2 must give a definite capability answer for. */
export const MODELS = [
  "spark-1.3",
  "spark-open",
  "wonder",
  "muse-code",
  "sam-3.1",
  "voice-transcribe",
] as const;
export const ModelKey = z.enum(MODELS);
export type ModelKey = z.infer<typeof ModelKey>;

/** The capabilities each model is probed for (ROADMAP T0.2). */
export const REQUIRED: Record<ModelKey, readonly string[]> = {
  "spark-1.3": ["text", "json_schema", "image", "video_inline", "video_file"],
  "spark-open": ["models_list", "text", "image", "video", "frames"],
  wonder: ["text", "computer_use"],
  "muse-code": ["api_model", "cli_headless"],
  "sam-3.1": ["image_text", "video_text", "video_box", "video_point"],
  "voice-transcribe": ["file", "realtime"],
};

/**
 * ok          the capability works (latency measured)
 * unsupported the API definitively rejects it (e.g. a 400 naming the modality)
 * error       no definite answer yet (missing key, outage, unexpected failure): rerun the probe
 */
export const Status = z.enum(["ok", "unsupported", "error"]);

export const ProbeResult = z.object({
  model: ModelKey,
  capability: z.string(),
  status: Status,
  latencyMs: z.object({ p50: z.number(), samples: z.array(z.number()) }).nullable(),
  /** Did the answer match the ground truth baked into the probe media? null when not scored. */
  correct: z.boolean().nullable(),
  request: z.unknown().optional(),
  response: z.unknown().optional(),
  limits: z.record(z.string(), z.string()).optional(),
  notes: z.string().optional(),
  error: z.string().optional(),
  at: z.string(),
});
export type ProbeResult = z.infer<typeof ProbeResult>;

export const ProbeResults = z.object({
  generatedAt: z.string(),
  results: z.array(ProbeResult),
});
export type ProbeResults = z.infer<typeof ProbeResults>;

/** Fresh results replace earlier ones for the same model/capability; output is in MODELS order. */
export function mergeResults(
  existing: readonly ProbeResult[],
  fresh: readonly ProbeResult[],
): ProbeResult[] {
  const key = (r: ProbeResult) => `${r.model}/${r.capability}`;
  const merged = new Map(existing.map((r) => [key(r), r]));
  for (const r of fresh) merged.set(key(r), r);
  return [...merged.values()].sort(
    (a, b) =>
      MODELS.indexOf(a.model) - MODELS.indexOf(b.model) || a.capability.localeCompare(b.capability),
  );
}
