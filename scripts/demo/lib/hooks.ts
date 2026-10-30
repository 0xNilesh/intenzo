import { createHmac } from "node:crypto";

// Calls into demo-shop's test hooks (ARCHITECTURE §21.1, reference implementation in demo-shop's
// lib/hooks.ts). T1.3 builds the real identity acquisition into core; this is enough for P0.

export function signHookCall(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac("sha256", secret)
    .update(timestamp + body)
    .digest("hex")}`;
}

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
