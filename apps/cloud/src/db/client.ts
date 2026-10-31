// The production database: node-postgres over Neon's pooled connection (§3 wants a driver with
// interactive transactions, so not neon-http). One pool per function instance. attachDatabasePool
// lets Fluid compute release idle clients before the instance suspends
// (vercel.com/docs/functions/functions-api-reference/vercel-functions-package).
import { attachDatabasePool } from "@vercel/functions";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import type { Db } from "./db.ts";
import * as schema from "./schema.ts";

let current: { url: string; db: Db } | undefined;

export function database(url: string): Db {
  if (current?.url !== url) {
    const pool = new Pool({ connectionString: url });
    attachDatabasePool(pool);
    current = { url, db: drizzle({ client: pool, schema }) };
  }
  return current.db;
}
