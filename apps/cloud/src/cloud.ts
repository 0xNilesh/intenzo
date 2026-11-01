// What every route works with: the settings, the database, GitHub as the App, and the outbox
// drainer. Read from the environment when a request needs them, so `next build` needs no secrets.
import { randomUUID } from "node:crypto";

import { database } from "./db/client.ts";
import { privatePut } from "./artifacts/put.ts";
import { artifactUrls, publicUrl } from "./artifacts/read-urls.ts";
import { buildBundle } from "./bundle/build.ts";
import { blobStores, cloudEnv, modalSettings } from "./env.ts";
import { githubClient } from "./github/api.ts";
import { installationTokens } from "./github/app-auth.ts";
import { drainOutbox } from "./outbox/drain.ts";
import { agentExecutors } from "./outbox/agent-effects.ts";
import { githubExecutors } from "./outbox/github-effects.ts";
import { jobExecutors } from "./outbox/job-effects.ts";
import { secretsKey } from "./secrets/seal.ts";

/** Where the report pages are: INTENZO_CLOUD_URL, set on Vercel. */
export const reportBaseUrl = (env: { INTENZO_CLOUD_URL?: string }) =>
  env.INTENZO_CLOUD_URL ?? "http://localhost:3000";

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
  const sealKey = env.INTENZO_SECRETS_KEY ? secretsKey(env.INTENZO_SECRETS_KEY) : null;
  const executors = {
    ...agentExecutors({
      db,
      github,
      reportBaseUrl: reportBaseUrl(env),
      fixerSecret: env.INTENZO_FIXER_SECRET ?? null,
    }),
    ...githubExecutors({
      db,
      github,
      reportBaseUrl: reportBaseUrl(env),
      publicFile: (path) => {
        const store = blobStores(env).public;
        return store ? publicUrl(store, path) : null;
      },
    }),
    ...(modal &&
      jobExecutors({
        db,
        modal,
        jobSecret: env.INTENZO_JOB_SECRET,
        secretsKey: sealKey,
        newJobId: randomUUID,
        now,
        log,
        bundle: ({ installationId, ...target }) =>
          buildBundle(
            {
              github: github(installationId),
              put: privatePut(blobStores(env).private),
              sign: artifactUrls(blobStores(env)),
              log,
            },
            target,
          ),
      })),
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
