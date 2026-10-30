import { pickLimits, request, type HttpResult } from "../lib/http.ts";
import { asArray, asString, dig } from "../lib/json.ts";
import { TRUTH } from "../lib/media.ts";
import { failed, quote, type Outcome, type ProbeContext } from "../lib/probe.ts";
import { shapeOf } from "../lib/shape.ts";
import { latency } from "../lib/stats.ts";
import { META_BASE, bearer, dataUrl, responsesText } from "./meta-api.ts";

const MAX_TURNS = 3;

/**
 * The computer-use loop (Responses API only): the model returns a computer_call with a batch of
 * actions in screenshot pixels, and we answer with a computer_call_output screenshot. Checks that
 * a click lands on the Apply button in the checkout screenshot. The docs name Wonder for this and
 * say Spark 1.3 runs the same loop more cheaply, so both models use this.
 */
export async function computerUse(ctx: ProbeContext, key: string, model: string): Promise<Outcome> {
  const headers = bearer(key);
  const screenshot = dataUrl(ctx.media.applyPng, "image/png");
  const tools = [{ type: "computer" }];
  const firstBody = {
    model,
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
      model,
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
}
