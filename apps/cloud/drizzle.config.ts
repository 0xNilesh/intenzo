// drizzle-kit (orm.drizzle.team/docs/drizzle-config-file). `pnpm db:generate` writes a migration
// for each change to src/db/schema.ts. `pnpm db:migrate` applies them to DATABASE_URL_UNPOOLED
// (Neon's direct connection; neon.com/docs/guides/vercel-managed-integration), else DATABASE_URL,
// from the environment or from apps/cloud/.env.local (`vercel env pull .env.local`).
import { existsSync } from "node:fs";

import { defineConfig } from "drizzle-kit";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? "" },
});
