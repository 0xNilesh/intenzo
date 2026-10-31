// POST /api/github/webhook (§12 Cloud HTTP surface). Verify the signature, keep only the events
// Intenzo acts on (§17), store each delivery once (webhook_events, §11), answer GitHub, then
// dispatch the event after the response has gone: the route defers it with Next's after().
import { z } from "zod";

import type { NewWebhookEvent } from "../db/webhook-events.ts";
import { verifyWebhookSignature } from "./signature.ts";

/** The §12 events. GitHub also sends others (ping; check_suite on every push, T0.4): dropped. */
export const HANDLED_EVENTS: ReadonlySet<string> = new Set([
  "installation",
  "installation_repositories",
  "pull_request",
  "deployment_status",
  "issues",
  "issue_comment",
  "check_run",
]);

/** The fields intake itself reads. Handlers validate the parts of the payload they use. */
const Envelope = z.looseObject({
  action: z.string().optional(),
  // deployment_status payloads carry "check_run": null (T0.4 fixtures).
  check_run: z.looseObject({ app: z.looseObject({ id: z.number() }).nullish() }).nullish(),
});
type Envelope = z.infer<typeof Envelope>;

export interface AcceptedEvent {
  /** Its webhook_events row. */
  id: number;
  deliveryId: string;
  event: string;
  action: string | null;
  /** Parsed with JSON.parse, so ids beyond 2^53 are rounded. The row's payload_json has them exact. */
  payload: unknown;
}

export interface IntakeDeps {
  /** The App's webhook secret. */
  secret: string;
  /** The App's id. The App receives every app's check runs and keeps only its own (T0.4). */
  appId: number;
  /** Stores the delivery. Null when this delivery id is already stored. */
  record: (event: NewWebhookEvent) => Promise<number | null>;
  dispatch: (event: AcceptedEvent) => Promise<void>;
  /** Runs work after the response has been sent (Next's after()). */
  defer: (work: () => Promise<void>) => void;
  now: () => Date;
}

export async function handleWebhook(request: Request, deps: IntakeDeps): Promise<Response> {
  const body = new Uint8Array(await request.arrayBuffer());
  if (!verifyWebhookSignature(deps.secret, body, request.headers.get("x-hub-signature-256"))) {
    return reply(401, { error: "invalid signature" });
  }
  const event = request.headers.get("x-github-event");
  const deliveryId = request.headers.get("x-github-delivery");
  if (!event || !deliveryId) {
    return reply(400, { error: "missing X-GitHub-Event or X-GitHub-Delivery" });
  }

  let text: string;
  let payload: unknown;
  let envelope: Envelope;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    payload = JSON.parse(text);
    envelope = Envelope.parse(payload);
  } catch {
    return reply(400, { error: "the body isn't a JSON object" });
  }

  const ignored = ignoreReason(event, envelope, deps.appId);
  if (ignored) return reply(200, { status: "ignored", reason: ignored });

  const action = envelope.action ?? null;
  const id = await deps.record({ deliveryId, event, action, body: text, receivedAt: deps.now() });
  if (id === null) return reply(200, { status: "duplicate" });
  deps.defer(() => deps.dispatch({ id, deliveryId, event, action, payload }));
  return reply(202, { status: "accepted" });
}

function ignoreReason(event: string, envelope: Envelope, appId: number): string | null {
  if (!HANDLED_EVENTS.has(event)) return `not an event Intenzo acts on: ${event}`;
  // DECISIONS 2026-10-30 · Platform checks, decision 6.
  if (event === "check_run" && envelope.check_run?.app?.id !== appId) {
    return "another app's check run";
  }
  return null;
}

function reply(status: number, body: Record<string, string>): Response {
  return Response.json(body, { status });
}
