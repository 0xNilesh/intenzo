// What every route works with: the settings, the database, GitHub as the App, and the outbox
// drainer. Read from the environment when a request needs them, so `next build` needs no secrets.
import { randomUUID } from "node:crypto";

import { database } from "./db/client.ts";
import { cloudEnv } from "./env.ts";
import { githubClient } from "./github/api.ts";
import { installationTokens } from "./github/app-auth.ts";
import { drainOutbox } from "./outbox/drain.ts";
import { githubExecutors } from "./outbox/github-effects.ts";

/** Installation tokens live for an hour, so one token cache per function instance. */
let tokens: { key: string; mint: (installationId: number) => Promise<string> } | undefined;

export function cloud() {
  const env = cloudEnv();
  const db = database(env.DATABASE_URL);
  const now = () => new Date();
  const app = { appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_APP_PRIVATE_KEY };
  const key = `${app.appId}\n${app.privateKey}`;
  if (tokens?.key !== key) tokens = { key, mint: installationTokens(app, now) };
  const { mint } = tokens;
  const github = (installationId: number) => githubClient(() => mint(installationId));
  const log = (line: string) => console.log(line);
  const executors = githubExecutors({ db, github });
  return {
    env,
    db,
    now,
    github,
    log,
    newRunId: randomUUID,
    drain: () => drainOutbox({ db, executors, now, log }),
  };
}
