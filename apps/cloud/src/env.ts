// The Cloud's settings, read from the environment (the Vercel project; locally .env.local) when a
// request needs them, so `next build` needs no secrets.
import { z } from "zod";

const CloudEnv = z.object({
  /** Neon's pooled connection string, set by the Vercel Marketplace integration. */
  DATABASE_URL: z.string().min(1),
  GITHUB_APP_ID: z.coerce.number().int().positive(),
  GITHUB_APP_WEBHOOK_SECRET: z.string().min(1),
  /**
   * The App's private key (PEM), to mint installation tokens. Its line breaks may also be written
   * as a backslash and an n, the way some tools store multi-line values.
   */
  GITHUB_APP_PRIVATE_KEY: z
    .string()
    .transform((pem) => pem.replaceAll("\\n", "\n").trim())
    .pipe(
      z
        .string()
        .regex(/^-----BEGIN [A-Z ]*PRIVATE KEY-----\n[\s\S]+\n-----END [A-Z ]*PRIVATE KEY-----$/),
    ),
  /** Signs the worker's job tokens (§8, §29). 32 characters at least. */
  INTENZO_JOB_SECRET: z.string().min(32),
  /**
   * Seals the repos' test secrets at rest (§29, T2.7b): 32 bytes, base64. Without it a repo's
   * sealed secrets can't be opened, so its jobs aren't spawned.
   */
  INTENZO_SECRETS_KEY: z
    .string()
    .regex(/^[A-Za-z0-9+/]{43}=$/)
    .optional(),
  /**
   * Signs the fix requests Intenzo posts for the repos' fixer agent (§26.3, T5.4); the agent's
   * workflow checks them with the same secret. Without it no request is posted.
   */
  INTENZO_FIXER_SECRET: z.string().min(32).optional(),
  /** What Modal's cron sends to POST /api/internal/sweep (T2.5b). */
  INTENZO_SWEEP_SECRET: z.string().min(32).optional(),
  /**
   * Modal (T2.5b): the spawn and cancel endpoints, their bearer secret, and the Cloud's own URL for
   * the jobs to report to. Until all four are set, no job is spawned.
   */
  MODAL_SPAWN_URL: z.url().optional(),
  MODAL_CANCEL_URL: z.url().optional(),
  MODAL_ENDPOINT_SECRET: z.string().min(32).optional(),
  INTENZO_CLOUD_URL: z.url().optional(),
  /**
   * The two Blob stores (§28), each reached with a read-write token or, when connected through
   * Vercel's OIDC, its store id. Until one is set, uploads to that store are refused (T2.6).
   */
  PUBLIC_BLOB_READ_WRITE_TOKEN: z.string().min(1).optional(),
  PUBLIC_BLOB_STORE_ID: z.string().min(1).optional(),
  PRIVATE_BLOB_READ_WRITE_TOKEN: z.string().min(1).optional(),
  PRIVATE_BLOB_STORE_ID: z.string().min(1).optional(),
});
export type CloudEnv = z.infer<typeof CloudEnv>;

/** Where and how the Cloud reaches Modal, or null until every part of it is set. */
export function modalSettings(env: CloudEnv) {
  const { MODAL_SPAWN_URL, MODAL_CANCEL_URL, MODAL_ENDPOINT_SECRET, INTENZO_CLOUD_URL } = env;
  if (!MODAL_SPAWN_URL || !MODAL_CANCEL_URL || !MODAL_ENDPOINT_SECRET || !INTENZO_CLOUD_URL) {
    return null;
  }
  return {
    spawnUrl: MODAL_SPAWN_URL,
    cancelUrl: MODAL_CANCEL_URL,
    secret: MODAL_ENDPOINT_SECRET,
    cloudUrl: INTENZO_CLOUD_URL,
  };
}
export type ModalSettings = NonNullable<ReturnType<typeof modalSettings>>;

/** The parsed settings. Throws naming each missing or invalid variable, never its value. */
export function cloudEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): CloudEnv {
  const parsed = CloudEnv.safeParse(env);
  if (parsed.success) return parsed.data;
  const names = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))];
  throw new Error(`Intenzo Cloud env vars missing or invalid: ${names.join(", ")}`);
}

export type BlobAuth = { token: string } | { storeId: string };

/** How the Cloud reaches each Blob store (§28): its token, else its store id with Vercel's OIDC. */
export function blobStores(env: CloudEnv): { public: BlobAuth | null; private: BlobAuth | null } {
  const auth = (token?: string, storeId?: string): BlobAuth | null =>
    token ? { token } : storeId ? { storeId } : null;
  return {
    public: auth(env.PUBLIC_BLOB_READ_WRITE_TOKEN, env.PUBLIC_BLOB_STORE_ID),
    private: auth(env.PRIVATE_BLOB_READ_WRITE_TOKEN, env.PRIVATE_BLOB_STORE_ID),
  };
}
