import { metaKey } from "../lib/env.ts";
import { request } from "../lib/http.ts";
import {
  capability,
  failed,
  missingKey,
  quote,
  sampled,
  succeeded,
  type Probe,
} from "../lib/probe.ts";
import { OK_PROMPT, scoreOk } from "../lib/questions.ts";
import { REQUIRED } from "../lib/results.ts";
import { computerUse } from "./computer-use.ts";
import { META_BASE, bearer, chatText } from "./meta-api.ts";

const MODEL = "muse-wonder-1.0";

export const probeWonder: Probe = async (ctx) => {
  const key = metaKey();
  if (!key) return missingKey(ctx, "wonder", REQUIRED.wonder, "META_API_KEY");
  const headers = bearer(key);

  await capability(ctx, "wonder", "text", async () => {
    const body = {
      model: MODEL,
      max_completion_tokens: 2048,
      messages: [{ role: "user", content: OK_PROMPT }],
    };
    const run = await sampled(ctx.samples, () =>
      request(`${META_BASE}/chat/completions`, { headers, json: body }),
    );
    if ("failure" in run) return failed(run.failure, body);
    const answer = chatText(run.last.body);
    return succeeded(run, body, scoreOk(answer), `answer: ${quote(answer)}`);
  });

  await capability(ctx, "wonder", "computer_use", () => computerUse(ctx, key, MODEL));
};
