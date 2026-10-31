// What every route works with: the settings, the database, GitHub as the App, and the outbox
// drainer. Read from the environment when a request needs them, so `next build` needs no secrets.
import { randomUUID } from "node:crypto";

import { database } from "./db/client.ts";
import { cloudEnv, modalSettings } from "./env.ts";
import { githubClient } from "./github/api.ts";
import { installationTokens } from "./github/app-auth.ts";
import { drainOutbox } from "./outbox/drain.ts";
import { githubExecutors } from "./outbox/github-effects.ts";
import { jobExecutors } from "./outbox/job-effects.ts";

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
  // Spawn and cancel run only once Modal is configured; until then those rows wait in the outbox.
  const modal = modalSettings(env);
  const executors = {
    ...githubExecutors({ db, github }),
    ...(modal &&
      jobExecutors({ db, modal, jobSecret: env.INTENZO_JOB_SECRET, newJobId: randomUUID, now })),
  };
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
