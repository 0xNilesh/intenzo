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
});
export type CloudEnv = z.infer<typeof CloudEnv>;

/** The parsed settings. Throws naming each missing or invalid variable, never its value. */
export function cloudEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): CloudEnv {
  const parsed = CloudEnv.safeParse(env);
  if (parsed.success) return parsed.data;
  const names = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))];
  throw new Error(`Intenzo Cloud env vars missing or invalid: ${names.join(", ")}`);
}
