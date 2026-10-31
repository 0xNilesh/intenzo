// A real Postgres server for the tests PGlite can't run (`*.pg.test.ts`): PGlite has one connection,
// so it can't show two transactions racing. Each test file gets a fresh database on the server at
// INTENZO_TEST_PG_URL (a local Postgres, or CI's service container), migrated like production and
// dropped afterwards.
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

import type { Db } from "./db.ts";
import * as schema from "./schema.ts";

const MIGRATIONS = fileURLToPath(new URL("../../drizzle", import.meta.url));

/** A server where the tests may create and drop databases. Defaults to a local Postgres. */
const SERVER = process.env.INTENZO_TEST_PG_URL ?? "postgres://localhost:5432/postgres";

export async function testPg(): Promise<{ db: Db; close: () => Promise<void> }> {
  const admin = new pg.Client({ connectionString: SERVER });
  try {
    await admin.connect();
  } catch (err) {
    const where = URL.parse(SERVER)?.host ?? "INTENZO_TEST_PG_URL";
    throw new Error(
      `The *.pg.test.ts tests need a Postgres server and found none at ${where} ` +
        `(${(err as { code?: string }).code ?? (err as Error).message}). Start one, or set ` +
        "INTENZO_TEST_PG_URL (apps/cloud/README.md).",
      { cause: err },
    );
  }
  const name = `intenzo_test_${randomBytes(4).toString("hex")}`;
  await admin.query(`create database ${name}`);
  const url = new URL(SERVER);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 8 });
  const db = drizzle({ client: pool, schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  return {
    db,
    close: async () => {
      await pool.end();
      // pool.end() resolves once it has asked each connection to close, not once they're closed.
      // Dropping the database with FORCE would kill those still closing, and their pg clients
      // would raise the error: wait until Postgres has let them go instead.
      for (let attempt = 1; ; attempt++) {
        try {
          await admin.query(`drop database ${name}`);
          break;
        } catch (err) {
          if ((err as { code?: string }).code !== "55006" || attempt === 50) throw err;
          await sleep(100);
        }
      }
      await admin.end();
    },
  };
}
