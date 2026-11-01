# The session hook

Intenzo records every acceptance criterion as a **brand-new user** on the app: one for exploring, one for each PR take, one for the base take. Each starts from the same clean state, so a recording never inherits another's cart, settings or half-finished form ([ARCHITECTURE §21.1](ARCHITECTURE.md#211-isolation-identity-per-execution)). Your app makes those users through one small route, the **session hook**, which only Intenzo can call.

Without a hook, Intenzo still records, but every verdict is capped at `inconclusive (no_isolation)`, and the report says how to add one.

## 1. Configure it

In `.intenzo.yml` on your default branch (Intenzo reads it from there, so a PR can't change it):

```yaml
version: 1
isolation:
  session_hook: /api/test/session   # POST, on the preview's own origin
```

Without a session hook, `reset_hook` plus a `users` pool also isolates, more slowly: lanes that share a user run one after another, with a reset before each. A `session_hook` is better.

## 2. The contract

Intenzo sends, before every execution:

```
POST /api/test/session
Content-Type: application/json
X-Intenzo-Timestamp: 1793523355
X-Intenzo-Signature: sha256=<hex HMAC-SHA256(secret, timestamp + body)>

{"nonce":"9b1c…"}
```

`timestamp + body` is the timestamp string followed by the raw body, byte for byte.

| Your hook answers | When |
| --- | --- |
| **200** `{"shopper":"<id>"}` with `Set-Cookie` for the new user's session | the call is signed and fresh. `shopper` must be a non-empty string: it names the user in the report |
| **403** | the app runs in **production** (`VERCEL_ENV === "production"`, or your stack's equivalent), checked **before** the signature: a valid signature must not open production either |
| **401** | the signature is wrong, or the timestamp is missing or more than 5 minutes off the server's clock |
| **503** | no secret is configured |

What the new user gets is up to your app: demo-shop gives each one the same $50.00 seed cart. Keep it to throwaway test users; the hook should never reach a real account.

## 3. A reference hook (Next.js App Router)

`app/api/test/session/route.ts`, about 15 lines; replace `createTestUser` with your app's own:

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

export async function POST(request: Request): Promise<Response> {
  if (process.env.VERCEL_ENV === "production") return Response.json({ error: "disabled in production" }, { status: 403 });
  const secret = process.env.INTENZO_HOOK_SECRET;
  if (!secret) return Response.json({ error: "INTENZO_HOOK_SECRET is not set" }, { status: 503 });
  const timestamp = request.headers.get("x-intenzo-timestamp") ?? "";
  const body = await request.text();
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(timestamp + body).digest("hex")}`);
  const given = Buffer.from(request.headers.get("x-intenzo-signature") ?? "");
  const fresh = /^\d{1,12}$/.test(timestamp) && Math.abs(Date.now() / 1000 - Number(timestamp)) <= 300;
  if (!fresh || given.length !== expected.length || !timingSafeEqual(given, expected)) return Response.json({ error: "bad signature" }, { status: 401 });
  const { id, sessionCookie } = await createTestUser(); // your app: a fresh user and its session
  return new Response(JSON.stringify({ shopper: id }), { headers: { "content-type": "application/json", "set-cookie": sessionCookie } });
}
```

demo-shop's [`lib/hooks.ts`](https://github.com/sumithprabhu/demo-shop/blob/main/lib/hooks.ts) is the tested original, with its reset hook. Any stack works the same way: an HMAC-SHA256 over the timestamp and the raw body, compared in constant time.

## 4. Give it a secret

- **Your app:** set `INTENZO_HOOK_SECRET` (for example `openssl rand -hex 32`) on your **Preview** deployments only. Production should never have it.
- **Intenzo:** the same value, sealed into the Cloud's database for your repo, never in the config file. The operator stores it with `pnpm repo:secrets` ([apps/cloud/README.md](../apps/cloud/README.md)), together with Vercel's protection bypass when previews are protected. A PR from a fork never gets either (§29).
- **A local run** (`pnpm intenzo run --local`) reads it from `DEMO_SHOP_HOOK_SECRET` in this repo's `.env`.

## 5. Check it

```bash
ts=$(date +%s); body='{"nonce":"check"}'
sig=$(printf '%s%s' "$ts" "$body" | openssl dgst -sha256 -hmac "$INTENZO_HOOK_SECRET" | sed 's/^.* //')
curl -s -i -X POST "$PREVIEW_URL/api/test/session" -H 'content-type: application/json' \
  -H "x-intenzo-timestamp: $ts" -H "x-intenzo-signature: sha256=$sig" -d "$body"
```

Expect `200`, a `{"shopper":"…"}` body and a `set-cookie` header. For a protected Vercel preview, add `-H "x-vercel-protection-bypass: $BYPASS"`.
