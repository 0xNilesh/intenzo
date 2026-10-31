// A Postgres for unit tests: PGlite runs it in-process (no Docker, no network), with the same
// migrations production gets.
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

import * as schema from "./schema.ts";

const MIGRATIONS = fileURLToPath(new URL("../../drizzle", import.meta.url));

export async function testDb() {
  const client = new PGlite();
  const db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  return { db, close: () => client.close() };
}
