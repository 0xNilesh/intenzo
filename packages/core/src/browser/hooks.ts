import { createHmac } from "node:crypto";

// The test-hook contract (ARCHITECTURE §21.1): every call carries X-Intenzo-Timestamp (unix seconds)
// and X-Intenzo-Signature = sha256=<hex HMAC-SHA256(hookSecret, timestamp + raw body)>. The hook
// rejects stale timestamps and refuses production. demo-shop's lib/hooks.ts is the reference.

export function signHookCall(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac("sha256", secret)
    .update(timestamp + body)
    .digest("hex")}`;
}

/** Headers for one hook call. The signature covers exactly `body`, so send it byte for byte. */
export function hookHeaders(
  secret: string,
  body: string,
  nowS = Math.floor(Date.now() / 1000),
): Record<string, string> {
  const timestamp = String(nowS);
  return {
    "content-type": "application/json",
    "x-intenzo-timestamp": timestamp,
    "x-intenzo-signature": signHookCall(secret, timestamp, body),
  };
}
