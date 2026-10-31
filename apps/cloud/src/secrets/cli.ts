// `pnpm repo:secrets`: seals a repo's test secrets into the Cloud's database (§29). It reads the
// secrets by name from the repo root's .env, INTENZO_SECRETS_KEY from .env.intenzo-cloud, and the
// database from apps/cloud/.env.local (`vercel env pull .env.local`). Nothing it prints holds a
// secret.
//
//   pnpm repo:secrets --repo sumithprabhu/demo-shop \
//     --hook-secret-env DEMO_SHOP_HOOK_SECRET --bypass-env DEMO_SHOP_BYPASS_SECRET
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "../db/schema.ts";
import { parseSecretsArgs, SECRETS_USAGE, setRepoSecrets } from "./repo-secrets.ts";
import { secretsKey } from "./seal.ts";

for (const file of ["../../../../.env", "../../../../.env.intenzo-cloud", "../../.env.local"]) {
  const path = fileURLToPath(new URL(file, import.meta.url));
  if (existsSync(path)) process.loadEnvFile(path);
}

try {
  const { repo, values } = parseSecretsArgs(process.argv.slice(2), process.env);
  const keyText = process.env.INTENZO_SECRETS_KEY;
  if (!keyText) throw new Error("INTENZO_SECRETS_KEY isn't set (.env.intenzo-cloud)");
  const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL isn't set (apps/cloud/.env.local)");
  const pool = new Pool({ connectionString: url });
  try {
    const db = drizzle({ client: pool, schema });
    const stored = await setRepoSecrets(db, secretsKey(keyText), repo, values);
    console.log(`Stored ${stored.fields.join(" and ")} for ${stored.repo}, sealed.`);
  } finally {
    await pool.end();
  }
} catch (err) {
  console.error(`repo:secrets: ${(err as Error).message}\n\n${SECRETS_USAGE}`);
  process.exitCode = 1;
}
