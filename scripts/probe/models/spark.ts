import { metaKey } from "../lib/env.ts";
import { request, type HttpResult } from "../lib/http.ts";
import { asString, dig } from "../lib/json.ts";
import {
  capability,
  failed,
  fileBlob,
  missingKey,
  quote,
  sampled,
  succeeded,
  type Probe,
} from "../lib/probe.ts";
import {
  IMAGE_QUESTION,
  OK_PROMPT,
  VIDEO_QUESTION,
  scoreImage,
  scoreOk,
  scoreTotals,
} from "../lib/questions.ts";
import { REQUIRED } from "../lib/results.ts";
import { computerUse } from "./computer-use.ts";
import { META_BASE, bearer, chatText, dataUrl, responsesText } from "./meta-api.ts";

const MODEL = "muse-spark-1.3";
// Spark reasons before it answers; leave room so a short answer isn't cut off at the limit.
const MAX_TOKENS = 2048;

export const probeSpark: Probe = async (ctx) => {
  const key = metaKey();
  if (!key) return missingKey(ctx, "spark-1.3", REQUIRED["spark-1.3"], "META_API_KEY");
  const headers = bearer(key);
  const chat = (body: unknown) => request(`${META_BASE}/chat/completions`, { headers, json: body });
  const ask = (content: unknown) => ({
    model: MODEL,
    max_completion_tokens: MAX_TOKENS,
    messages: [{ role: "user", content }],
  });

  await capability(ctx, "spark-1.3", "text", async () => {
    const body = ask(OK_PROMPT);
    const run = await sampled(ctx.samples, () => chat(body));
    if ("failure" in run) return failed(run.failure, body);
    const answer = chatText(run.last.body);
    return succeeded(run, body, scoreOk(answer), `answer: ${quote(answer)}`);
  });

  await capability(ctx, "spark-1.3", "json_schema", async () => {
    const body = {
      ...ask("The order total is $45.00. Extract the total."),
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "OrderTotal",
          strict: true,
          schema: {
            type: "object",
            properties: { total: { type: "number" } },
            required: ["total"],
            additionalProperties: false,
          },
        },
      },
    };
    const run = await sampled(ctx.samples, () => chat(body));
    if ("failure" in run) return failed(run.failure, body);
    const answer = chatText(run.last.body);
    let total: unknown;
    try {
      total = dig(JSON.parse(answer), "total");
    } catch {
      total = undefined;
    }
    return succeeded(run, body, total === 45, `answer: ${quote(answer)}`);
  });

  await capability(ctx, "spark-1.3", "image", async () => {
    const body = ask([
      { type: "text", text: IMAGE_QUESTION },
      { type: "image_url", image_url: { url: dataUrl(ctx.media.cartPng, "image/png") } },
    ]);
    const run = await sampled(ctx.samples, () => chat(body));
    if ("failure" in run) return failed(run.failure, body);
    const answer = chatText(run.last.body);
    return succeeded(run, body, scoreImage(answer), `answer: ${quote(answer)}`);
  });

  await capability(ctx, "spark-1.3", "video_inline", async () => {
    const body = ask([
      { type: "text", text: VIDEO_QUESTION },
      { type: "video_url", video_url: { url: dataUrl(ctx.media.cartMp4, "video/mp4") } },
    ]);
    const run = await sampled(ctx.samples, () => chat(body));
    if ("failure" in run) return failed(run.failure, body);
    const answer = chatText(run.last.body);
    return succeeded(run, body, scoreTotals(answer), `answer: ${quote(answer)}`);
  });

  await capability(ctx, "spark-1.3", "video_file", async () => {
    const form = new FormData();
    form.append("purpose", "user_data");
    form.append("file", fileBlob(ctx.media.cartMp4, "video/mp4"), "cart.mp4");
    const upload = await request(`${META_BASE}/files`, { headers, form });
    if (!upload.ok) return failed(upload, { purpose: "user_data", file: "<cart.mp4>" });
    const fileId = asString(dig(upload.body, "id"));
    try {
      // The docs show both part types for an uploaded video; record which one is accepted.
      let rejected: HttpResult | undefined;
      for (const part of [
        { type: "input_video", file_id: fileId },
        { type: "input_file", file_id: fileId },
      ]) {
        const body = {
          model: MODEL,
          max_output_tokens: MAX_TOKENS,
          input: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: VIDEO_QUESTION }, part],
            },
          ],
        };
        const run = await sampled(ctx.samples, () =>
          request(`${META_BASE}/responses`, { headers, json: body }),
        );
        if ("failure" in run) {
          rejected = run.failure;
          continue;
        }
        const answer = responsesText(run.last.body);
        return succeeded(
          run,
          body,
          scoreTotals(answer),
          `part: ${part.type}; upload ${Math.round(upload.ms)} ms; answer: ${quote(answer)}`,
        );
      }
      return failed(rejected!);
    } finally {
      await request(`${META_BASE}/files/${fileId}`, { method: "DELETE", headers });
    }
  });

  // The docs say Spark 1.3 can run the computer-use loop more cheaply than Wonder.
  await capability(ctx, "spark-1.3", "computer_use", () => computerUse(ctx, key, MODEL));
};
