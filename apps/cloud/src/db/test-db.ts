// A Postgres for unit tests: PGlite runs it in-process (no Docker, no network), with the same
// migrations production gets.
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

import type { Db } from "./db.ts";
import * as schema from "./schema.ts";

const MIGRATIONS = fileURLToPath(new URL("../../drizzle", import.meta.url));

export async function testDb() {
  const client = new PGlite();
  const db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  return { db, close: () => client.close() };
}

/** Empties every table and adds demo-shop's installation and repo, as T2.1 installed them. */
export async function resetWithDemoShop(db: Db) {
  await db.execute(
    sql`truncate ${schema.outbox}, ${schema.criteriaResults}, ${schema.savedPaths}, ${schema.modelCalls}, ${schema.runs}, ${schema.intentVersions}, ${schema.runGroups}, ${schema.deployments}, ${schema.repos}, ${schema.installations}, ${schema.webhookEvents} restart identity cascade`,
  );
  const [installation] = await db
    .insert(schema.installations)
    .values({ ghInstallationId: 177107116, account: "sumithprabhu" })
    .returning();
  const [repo] = await db
    .insert(schema.repos)
    .values({
      installationId: installation!.id,
      ghRepoId: 1_087_000_001,
      fullName: "sumithprabhu/demo-shop",
      defaultBranch: "main",
    })
    .returning();
  return repo!;
}
