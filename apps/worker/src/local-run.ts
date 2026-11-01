import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

import { type ArtifactRef, type CriterionSet, VerifyJob } from "@intenzo/core";
import { extractIntent, prepareTicketVideo } from "@intenzo/core/intent";
import { judgesFromEnv } from "@intenzo/core/judge";
import { metaModelPort } from "@intenzo/core/models";

import type { JobClient, OutgoingEvent } from "./job/client.ts";
import { browserRecorder } from "./job/recorder.ts";
import { type StoredFile, verify } from "./job/verify.ts";
import { readCriteria } from "./coverage.ts";
import { readTicketFile } from "./intent.ts";
import {
  DEFAULT_BYPASS_ENV,
  DEFAULT_CONFIG,
  DEFAULT_HOOK_SECRET_ENV,
  isLocal,
  loadConfig,
  localRunDir,
  REPO,
  UsageError,
} from "./record.ts";

// `intenzo run --local`: the verify job end to end on this machine, without the Cloud (ROADMAP
// T4.6b): the criteria (a ticket read by Spark, or criterion files), each recorded on the PR app
// and the base app, judged by Spark Open and Spark 1.3, with every event printed. The videos stay
// in --out. Costs one intent call (with --ticket) and two judge calls per criterion, plus two
// more for each re-record: about $0.10 for C1–C4. Needs META_API_KEY and BASETEN_API_KEY.
//
//   pnpm intenzo run --local --pr <url> --base <url> --ticket fixtures/tickets/42.md

export const RUN_USAGE = `Usage: pnpm intenzo run --local --pr <url> [--base <url>]
         (--ticket <ticket.md> [--video <recording.mp4>] | --criteria <dir>)
         [--explore] [--config <.intenzo.yml>] [--out <dir>]

  --ticket    read the criteria with Spark 1.3 (intent.v1); --video adds the PM's recording
  --criteria  a folder of Criterion files instead (no intent call)
  --explore   let the navigator find each path (Wonder); else the hand-written fixtures/paths
  --out       where the takes' videos go (default: out/runs/local-<UTC time>)`;

export function parseRunArgs(argv: readonly string[]) {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        local: { type: "boolean" },
        pr: { type: "string" },
        base: { type: "string" },
        ticket: { type: "string" },
        video: { type: "string" },
        criteria: { type: "string" },
        explore: { type: "boolean" },
        config: { type: "string" },
        out: { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  if (!values.local)
    throw new UsageError("only --local runs are supported here; hosted runs start from GitHub");
  if (!values.pr || !URL.canParse(values.pr)) throw new UsageError("--pr <url> is required");
  if (values.base !== undefined && !URL.canParse(values.base))
    throw new UsageError("--base must be a URL");
  if (Boolean(values.ticket) === Boolean(values.criteria)) {
    throw new UsageError("give --ticket <file> or --criteria <dir>, not both");
  }
  if (values.video && !values.ticket) throw new UsageError("--video goes with --ticket");
  return {
    pr: values.pr,
    ...(values.base && { base: values.base }),
    ...(values.ticket && { ticket: values.ticket }),
    ...(values.video && { video: values.video }),
    ...(values.criteria && { criteria: values.criteria }),
    explore: values.explore ?? false,
    config: values.config ?? DEFAULT_CONFIG,
    ...(values.out && { out: values.out }),
  };
}

const ICON = { pass: "✅", fail: "❌", inconclusive: "⚪" } as const;

/** One line (or a few) per event, as the comment would show it. */
export function describeEvent(event: OutgoingEvent): string[] {
  switch (event.kind) {
    case "path_saved":
      return [`${event.path.criterionId}: saved the path it explored`];
    case "criterion_verdict": {
      const v = event.verdict;
      return [
        `${v.criterionId} ${ICON[v.verdict]} ${v.verdict} (${v.reasonCode}) · ${v.observed}`,
        ...v.judges.map(
          (j) =>
            `   ${j.model}: ${j.verdict} [${j.citedReadings.join(",")}] ${JSON.stringify(j.citedValue)}`,
        ),
      ];
    }
    default:
      return [];
  }
}

export async function runLocal(argv: readonly string[]): Promise<number> {
  const args = parseRunArgs(argv);
  const cwd = process.env.INIT_CWD ?? process.cwd();
  if (existsSync(join(REPO, ".env"))) process.loadEnvFile(join(REPO, ".env"));
  const apiKey = process.env.META_API_KEY ?? process.env.MODEL_API_KEY;
  const judges = judgesFromEnv(process.env);
  if (!judges)
    console.log("⚠ META_API_KEY or BASETEN_API_KEY isn't set: the verdicts are the stub's");

  const config = loadConfig(
    args.config === DEFAULT_CONFIG ? join(REPO, DEFAULT_CONFIG) : resolve(cwd, args.config),
  );
  const hookSecret = config.isolation.session_hook
    ? process.env[DEFAULT_HOOK_SECRET_ENV]
    : undefined;
  const remote = !isLocal(new URL(args.pr).origin);
  const bypass = remote ? process.env[DEFAULT_BYPASS_ENV] : undefined;

  // The criteria: from criterion files, or read from the ticket by Spark (§18).
  let intent: CriterionSet;
  if (args.criteria) {
    const criteria = readCriteria(resolve(cwd, args.criteria));
    const hash = createHash("sha256").update(JSON.stringify(criteria)).digest("hex");
    intent = { criteria, intentSource: "linked_issue", ticketHash: hash };
  } else {
    if (!apiKey) throw new UsageError("--ticket needs META_API_KEY in .env");
    const file = resolve(cwd, args.ticket!);
    const ticket = readTicketFile(readFileSync(file, "utf8"), `#${basename(file, ".md")}`);
    const video = args.video
      ? await prepareTicketVideo(resolve(cwd, args.video), { apiKey })
      : undefined;
    const read = await extractIntent(metaModelPort({ apiKey }), ticket, {
      ...(video && {
        transcript: video.transcript.text,
        video: {
          dataUrl: video.dataUrl,
          ...(video.transcript.audioDurationMs && { durationMs: video.transcript.audioDurationMs }),
        },
        mediaHashes: [video.mediaHash],
      }),
    });
    if (!read.ok) console.log(`⚠ ${read.problems.join("; ")}`);
    intent = read.intent;
  }
  console.log(
    `intenzo run --local · ${intent.criteria.length} criteria · PR ${args.pr}${args.base ? ` · base ${args.base}` : ""}`,
  );
  for (const c of intent.criteria) console.log(`  ${c.id} [${c.kind}] ${c.text}`);

  const runId = randomUUID();
  const out = args.out ? resolve(cwd, args.out) : join(REPO, localRunDir(new Date()));
  const job = VerifyJob.parse({
    type: "verify",
    jobId: randomUUID(),
    runId,
    deadlineAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    callback: { baseUrl: "http://localhost", token: "local" },
    config,
    bundleUrl: null,
    intent,
    prUrl: args.pr,
    baseUrl: args.base ?? null,
    baseSha: null,
    secrets: { ...(hookSecret && { hookSecret }), ...(bypass && { bypass }) },
    cachedPaths: [],
  });

  const client: JobClient = {
    async send(event) {
      for (const line of describeEvent(event)) console.log(line);
    },
    async alive() {},
    async uploadUrls() {
      throw new Error("a local run keeps its files in --out");
    },
  };
  // Each take's human video goes to --out/<criterion>/<side>/take-<n>/, as §28 lays out the store.
  const takes = new Map<string, number>();
  const store = async (
    lane: { criterionId: string; side: string },
    file: StoredFile,
  ): Promise<ArtifactRef> => {
    const key = `${lane.criterionId}/${lane.side}/${file.name}`;
    // The evidence names its take: the one whose video it was cut from.
    const take = file.take ?? (takes.get(key) ?? 0) + 1;
    takes.set(key, take);
    const path = join(out, lane.criterionId, lane.side, `take-${take}`, file.name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.body);
    return {
      store: file.store ?? "private",
      path: relative(out, path),
      contentType: file.contentType,
      bytes: file.body.byteLength,
    };
  };

  const started = Date.now();
  const recorder = browserRecorder(args.explore && apiKey ? { modelApiKey: apiKey } : {});
  try {
    const result = await verify(job, client, {
      recorder,
      judges,
      log: (line) => console.log(`  · ${line}`),
      store,
    });
    console.log(
      `\noutcome: ${result.outcome} · judges and navigator $${result.costUsd.toFixed(4)} · ${Math.round((Date.now() - started) / 1000)} s · takes in ${relative(cwd, out) || "."}`,
    );
    return 0;
  } finally {
    await recorder.close();
  }
}
