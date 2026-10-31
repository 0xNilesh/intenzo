// A repo's test secrets (§21.1, §29): the session hook's secret, the test users and Vercel's
// protection bypass. The operator stores them sealed with `pnpm repo:secrets` (cli.ts); the spawn
// effect opens them into a VerifyJob, for PRs that don't come from a fork.
import { parseArgs } from "node:util";

import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import type { Db } from "../db/db.ts";
import { repos } from "../db/schema.ts";
import { open, seal, type SecretField } from "./seal.ts";

const Users = z.array(z.object({ username: z.string(), password: z.string() }));

export interface RepoSecrets {
  hookSecret?: string;
  bypass?: string;
  users?: z.infer<typeof Users>;
}

type SealedColumns = Pick<
  typeof repos.$inferSelect,
  "ghRepoId" | "hookSecretEnc" | "usersEnc" | "bypassEnc"
>;

/** Opens the secrets a repo has. Throws if one doesn't open, naming its column only. */
export function repoSecrets(key: Buffer, repo: SealedColumns): RepoSecrets {
  const secrets: RepoSecrets = {};
  if (repo.hookSecretEnc) {
    secrets.hookSecret = open(key, repo.hookSecretEnc, repo.ghRepoId, "hook_secret");
  }
  if (repo.bypassEnc) secrets.bypass = open(key, repo.bypassEnc, repo.ghRepoId, "bypass");
  if (repo.usersEnc) {
    const text = open(key, repo.usersEnc, repo.ghRepoId, "users");
    let users: unknown;
    try {
      users = JSON.parse(text);
    } catch {
      users = undefined; // JSON.parse's message quotes the text, so it isn't passed on
    }
    const parsed = Users.safeParse(users);
    if (!parsed.success)
      throw new Error("the repo's users aren't a list of usernames and passwords");
    secrets.users = parsed.data;
  }
  return secrets;
}

export interface SecretValues {
  hookSecret?: string;
  bypass?: string;
}

/** Seals the given secrets into the repo's row; the others stay as they are. */
export async function setRepoSecrets(
  db: Db,
  key: Buffer,
  fullName: string,
  values: SecretValues,
): Promise<{ repo: string; fields: SecretField[] }> {
  const [repo] = await db
    .select()
    .from(repos)
    .where(sql`lower(${repos.fullName}) = lower(${fullName})`);
  if (!repo) {
    throw new Error(
      `Intenzo has no repo ${fullName}: it adds a repo at the first webhook it gets from it`,
    );
  }
  const set: Partial<typeof repos.$inferInsert> = {};
  const fields: SecretField[] = [];
  if (values.hookSecret !== undefined) {
    set.hookSecretEnc = seal(key, values.hookSecret, repo.ghRepoId, "hook_secret");
    fields.push("hook_secret");
  }
  if (values.bypass !== undefined) {
    set.bypassEnc = seal(key, values.bypass, repo.ghRepoId, "bypass");
    fields.push("bypass");
  }
  if (fields.length === 0) throw new Error("no secret to store");
  await db.update(repos).set(set).where(eq(repos.id, repo.id));
  return { repo: repo.fullName, fields };
}

export const SECRETS_USAGE = `Usage: pnpm repo:secrets --repo <owner/name> [--hook-secret-env <NAME>] [--bypass-env <NAME>]

  --hook-secret-env  the env var holding the session hook's secret (e.g. DEMO_SHOP_HOOK_SECRET)
  --bypass-env       the env var holding Vercel's protection bypass (e.g. DEMO_SHOP_BYPASS_SECRET)

The values are read from the environment (the repo root's .env), never from the command line.`;

/** The command's arguments, with each secret read from the env var it names. */
export function parseSecretsArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): { repo: string; values: SecretValues } {
  const { values: args } = parseArgs({
    args: [...argv],
    options: {
      repo: { type: "string" },
      "hook-secret-env": { type: "string" },
      "bypass-env": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (!args.repo || !/^[\w.-]+\/[\w.-]+$/.test(args.repo)) {
    throw new Error("--repo owner/name is required");
  }
  const read = (name: string) => {
    const value = env[name];
    if (!value) throw new Error(`${name} isn't set (add it to the repo root's .env)`);
    return value;
  };
  const values: SecretValues = {};
  if (args["hook-secret-env"]) values.hookSecret = read(args["hook-secret-env"]);
  if (args["bypass-env"]) values.bypass = read(args["bypass-env"]);
  if (Object.keys(values).length === 0) {
    throw new Error("name at least one secret: --hook-secret-env NAME, --bypass-env NAME");
  }
  return { repo: args.repo, values };
}
