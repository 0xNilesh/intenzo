// Webhook signatures (§29; docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries).
// X-Hub-Signature-256 is "sha256=" + the hex HMAC-SHA256 of the raw request body, keyed with the
// App's webhook secret. It's checked on the bytes GitHub sent, before any JSON parsing, and in
// constant time.
import { createHmac, timingSafeEqual } from "node:crypto";

const PREFIX = "sha256=";

/** The X-Hub-Signature-256 value GitHub sends with `body`. Strings are hashed as UTF-8. */
export function signWebhook(secret: string, body: string | Uint8Array): string {
  return PREFIX + createHmac("sha256", secret).update(body).digest("hex");
}

/** Whether `header` is GitHub's signature of `body`. An empty secret never verifies anything. */
export function verifyWebhookSignature(
  secret: string,
  body: string | Uint8Array,
  header: string | null,
): boolean {
  if (!secret || !header?.startsWith(PREFIX)) return false;
  const expected = Buffer.from(signWebhook(secret, body));
  const actual = Buffer.from(header);
  // timingSafeEqual throws on a length mismatch, and the length isn't secret.
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
