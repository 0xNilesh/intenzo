import { metaKey } from "../lib/env.ts";
import { pickLimits, request, type HttpResult } from "../lib/http.ts";
import { asArray, asString, dig } from "../lib/json.ts";
import { TRUTH } from "../lib/media.ts";
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
import { shapeOf } from "../lib/shape.ts";
import { latency } from "../lib/stats.ts";
import { META_BASE, bearer, chatText, dataUrl, responsesText } from "./meta-api.ts";

const MODEL = "muse-wonder-1.0";
const MAX_TURNS = 3;

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

  // Computer use is Responses-API only: the model returns a computer_call with a batch of
  // actions in screenshot pixels; we answer with a computer_call_output screenshot (docs).
  await capability(ctx, "wonder", "computer_use", async () => {
    const screenshot = dataUrl(ctx.media.applyPng, "image/png");
    const tools = [{ type: "computer" }];
    const firstBody = {
      model: MODEL,
      tools,
      input: [
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "This is the current browser screen. Click the Apply button.",
            },
            { type: "input_image", image_url: screenshot },
          ],
        },
      ],
    };
    let body: Record<string, unknown> = firstBody;
    const samples: number[] = [];
    const actionTypes = new Set<string>();
    let last: HttpResult | undefined;
    let click: { x: number; y: number } | undefined;
    let note = "";

    for (let turn = 0; turn < MAX_TURNS && !click; turn++) {
      const res = await request(`${META_BASE}/responses`, { headers, json: body });
      if (!res.ok) return failed(res, body);
      samples.push(res.ms);
      last = res;
      const call = asArray(dig(res.body, "output")).find((i) => dig(i, "type") === "computer_call");
      if (!call) {
        note = `no computer_call; model said ${quote(responsesText(res.body))}`;
        break;
      }
      const actions = asArray(dig(call, "actions"));
      for (const action of actions) actionTypes.add(asString(dig(action, "type")));
      const hit = actions.find((a) => ["click", "double_click"].includes(asString(dig(a, "type"))));
      if (hit) {
        click = { x: Number(dig(hit, "x")), y: Number(dig(hit, "y")) };
        break;
      }
      body = {
        model: MODEL,
        tools,
        previous_response_id: dig(res.body, "id"),
        input: [
          {
            type: "computer_call_output",
            call_id: dig(call, "call_id"),
            acknowledged_safety_checks: asArray(dig(call, "pending_safety_checks")),
            output: { type: "computer_screenshot", image_url: screenshot },
          },
        ],
      };
    }

    const b = TRUTH.applyButton;
    const onButton =
      !!click && click.x >= b.x1 && click.x <= b.x2 && click.y >= b.y1 && click.y <= b.y2;
    return {
      status: "ok",
      latencyMs: latency(samples),
      correct: onButton,
      request: shapeOf(firstBody),
      response: shapeOf(last?.body),
      limits: last ? pickLimits(last.headers) : undefined,
      notes: [
        `turns: ${samples.length}`,
        `action types: ${[...actionTypes].join(", ") || "none"}`,
        click
          ? `click at (${click.x}, ${click.y}); button spans x ${b.x1}-${b.x2}, y ${b.y1}-${b.y2}`
          : "no click",
        note,
      ]
        .filter(Boolean)
        .join("; "),
    };
  });
};
