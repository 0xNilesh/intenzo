import { basetenKey } from "../lib/env.ts";
import { pickLimits, request } from "../lib/http.ts";
import { asArray, asString, dig } from "../lib/json.ts";
import {
  capability,
  failed,
  missingKey,
  quote,
  sampled,
  succeeded,
  type Probe,
} from "../lib/probe.ts";
import {
  FRAMES_QUESTION,
  IMAGE_QUESTION,
  OK_PROMPT,
  VIDEO_QUESTION,
  scoreImage,
  scoreOk,
  scoreTotals,
} from "../lib/questions.ts";
import { REQUIRED } from "../lib/results.ts";
import { shapeOf } from "../lib/shape.ts";
import { latency } from "../lib/stats.ts";
import { chatText, dataUrl } from "./meta-api.ts";

// Muse Spark Open on Baseten Model APIs (OpenAI-compatible Chat Completions). Baseten's
// announcement uses "meta-models/muse-spark-open"; the hackathon guide says "...-1026", so the
// probe lists the models this key can see instead of guessing. SPARK_OPEN_MODEL overrides.
const BASE = "https://inference.baseten.co/v1";
const FALLBACK_MODEL = "meta-models/muse-spark-open";
const MAX_TOKENS = 2048;

export const probeSparkOpen: Probe = async (ctx) => {
  const key = basetenKey();
  if (!key) return missingKey(ctx, "spark-open", REQUIRED["spark-open"], "BASETEN_API_KEY");
  const headers = { Authorization: `Bearer ${key}` };
  const chat = (body: unknown) => request(`${BASE}/chat/completions`, { headers, json: body });
  let model = process.env.SPARK_OPEN_MODEL || FALLBACK_MODEL;
  const ask = (content: unknown) => ({
    model,
    max_tokens: MAX_TOKENS,
    messages: [{ role: "user", content }],
  });

  await capability(ctx, "spark-open", "models_list", async () => {
    const res = await request(`${BASE}/models`, { headers });
    if (!res.ok) return failed(res);
    const ids = asArray(dig(res.body, "data")).map((m) => asString(dig(m, "id")));
    const matches = ids.filter((id) => /muse-spark-open/i.test(id));
    if (!process.env.SPARK_OPEN_MODEL && matches[0]) model = matches[0];
    return {
      status: matches.length > 0 ? "ok" : "unsupported",
      latencyMs: latency([res.ms]),
      correct: null,
      response: shapeOf(res.body),
      limits: pickLimits(res.headers),
      notes: `using ${model}; matching ids: ${matches.join(", ") || "none"} (of ${ids.length})`,
    };
  });

  await capability(ctx, "spark-open", "text", async () => {
    const body = ask(OK_PROMPT);
    // Model APIs are shared deployments; the first call is still timed on its own as a
    // cold-start proxy before the sampled calls.
    const first = await chat(body);
    if (!first.ok) return failed(first, body);
    const run = await sampled(ctx.samples, () => chat(body));
    if ("failure" in run) return failed(run.failure, body);
    const answer = chatText(run.last.body);
    return succeeded(
      run,
      body,
      scoreOk(answer),
      `first call ${Math.round(first.ms)} ms; answer: ${quote(answer)}`,
    );
  });

  await capability(ctx, "spark-open", "image", async () => {
    const body = ask([
      { type: "text", text: IMAGE_QUESTION },
      { type: "image_url", image_url: { url: dataUrl(ctx.media.cartPng, "image/png") } },
    ]);
    const run = await sampled(ctx.samples, () => chat(body));
    if ("failure" in run) return failed(run.failure, body);
    const answer = chatText(run.last.body);
    return succeeded(run, body, scoreImage(answer), `answer: ${quote(answer)}`);
  });

  // Native video: the same video_url part Meta's API takes. A 4xx naming video means "no".
  await capability(ctx, "spark-open", "video", async () => {
    const body = ask([
      { type: "text", text: VIDEO_QUESTION },
      { type: "video_url", video_url: { url: dataUrl(ctx.media.cartMp4, "video/mp4") } },
    ]);
    const run = await sampled(ctx.samples, () => chat(body));
    if ("failure" in run) return failed(run.failure, body);
    const answer = chatText(run.last.body);
    return succeeded(run, body, scoreTotals(answer), `answer: ${quote(answer)}`);
  });

  // Frames mode (ARCHITECTURE §14): timestamped stills, the fallback if native video isn't there.
  await capability(ctx, "spark-open", "frames", async () => {
    const body = ask([
      { type: "text", text: FRAMES_QUESTION },
      ...ctx.media.frames.flatMap((f) => [
        { type: "text", text: `t=${f.atS}s` },
        { type: "image_url", image_url: { url: dataUrl(f.path, "image/jpeg") } },
      ]),
    ]);
    const run = await sampled(ctx.samples, () => chat(body));
    if ("failure" in run) return failed(run.failure, body);
    const answer = chatText(run.last.body);
    return succeeded(
      run,
      body,
      scoreTotals(answer),
      `${ctx.media.frames.length} frames; answer: ${quote(answer)}`,
    );
  });
};
