// A repo's test secrets at rest (§11, §29): the session hook's secret, the test users and Vercel's
// protection bypass are stored sealed with AES-256-GCM under INTENZO_SECRETS_KEY, and opened only
// to build a VerifyJob. Each value is bound to its repo and column (GCM's additional data), so a
// sealed value copied to another repo or column doesn't open.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export type SecretField = "hook_secret" | "users" | "bypass";

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** INTENZO_SECRETS_KEY: 32 random bytes, base64 (`openssl rand -base64 32`). */
export function secretsKey(base64: string): Buffer {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(base64)) {
    throw new Error("INTENZO_SECRETS_KEY must be 32 bytes, base64 (openssl rand -base64 32)");
  }
  return Buffer.from(base64, "base64");
}

const boundTo = (ghRepoId: number, field: SecretField) =>
  Buffer.from(`intenzo:repo:${ghRepoId}:${field}`);

/** Seals a secret for one repo's column: "v1.<iv>.<ciphertext>.<tag>", each part base64url. */
export function seal(key: Buffer, secret: string, ghRepoId: number, field: SecretField): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(boundTo(ghRepoId, field));
  const body = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, ...[iv, body, tag].map((part) => part.toString("base64url"))].join(".");
}

/** Opens what seal() sealed for the same repo and column. Its errors never include a secret. */
export function open(key: Buffer, sealed: string, ghRepoId: number, field: SecretField): string {
  const [version, ...parts] = sealed.split(".");
  if (version !== VERSION || parts.length !== 3) {
    throw new Error(`the repo's ${field} isn't a sealed secret`);
  }
  const [iv, body, tag] = parts.map((part) => Buffer.from(part, "base64url"));
  if (iv!.length !== IV_BYTES || tag!.length !== TAG_BYTES) {
    throw new Error(`the repo's ${field} isn't a sealed secret`);
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv!, { authTagLength: TAG_BYTES });
    decipher.setAAD(boundTo(ghRepoId, field));
    decipher.setAuthTag(tag!);
    return Buffer.concat([decipher.update(body!), decipher.final()]).toString("utf8");
  } catch {
    throw new Error(
      `the repo's ${field} didn't open: another key, another repo or column, or changed`,
    );
  }
}
