// Job tokens (§8, §29): the worker's only credential. An HS256 JWT for one job of one run, signed
// with the Cloud's job secret and valid until 5 minutes after the job's deadline. The worker never
// gets a GitHub token.
import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

export interface JobClaims {
  jobId: string;
  runId: string;
  /** Expiry, in seconds since the epoch. */
  exp: number;
}

/** §8: a token outlives its job's deadline by 5 minutes, so the job can report how it ended. */
export const TOKEN_GRACE_S = 300;

export function tokenExpiry(deadlineAt: Date): number {
  return Math.floor(deadlineAt.getTime() / 1000) + TOKEN_GRACE_S;
}

const HEADER = { alg: "HS256", typ: "JWT" };
const Payload = z.object({
  iss: z.literal("intenzo-cloud"),
  sub: z.uuid(),
  run: z.uuid(),
  exp: z.number().int(),
});

const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const sign = (secret: string, unsigned: string) =>
  createHmac("sha256", secret).update(unsigned).digest();

export function signJobToken(secret: string, claims: JobClaims): string {
  if (!secret) throw new Error("no job secret to sign with");
  const payload = { iss: "intenzo-cloud", sub: claims.jobId, run: claims.runId, exp: claims.exp };
  const unsigned = `${part(HEADER)}.${part(payload)}`;
  return `${unsigned}.${sign(secret, unsigned).toString("base64url")}`;
}

/**
 * The claims of a token this Cloud signed that hasn't expired, else null. Only HS256 is accepted,
 * so a token can't pick its own algorithm ("none"), and the signature is compared in constant time.
 */
export function verifyJobToken(secret: string, token: string, nowS: number): JobClaims | null {
  if (!secret) return null;
  const [header, payload, signature, extra] = token.split(".");
  if (!header || !payload || !signature || extra !== undefined) return null;
  const expected = sign(secret, `${header}.${payload}`);
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const parsedHeader = JSON.parse(Buffer.from(header, "base64url").toString()) as object;
    if (JSON.stringify(parsedHeader) !== JSON.stringify(HEADER)) return null;
    const claims = Payload.parse(JSON.parse(Buffer.from(payload, "base64url").toString()));
    if (claims.exp <= nowS) return null;
    return { jobId: claims.sub, runId: claims.run, exp: claims.exp };
  } catch {
    return null;
  }
}

/** The token in an `Authorization: Bearer …` header, if there is one. */
export function bearerToken(request: Request): string | null {
  const match = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "");
  return match?.[1] ?? null;
}
