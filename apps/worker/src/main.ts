// Entry point for the local `intenzo` CLI, and for jobs on Modal (`intenzo job`, T2.5).
//   pnpm intenzo <command> [options]
import { JOB_USAGE, runJobCommand } from "./job/command.ts";
import { EXPLORE_USAGE, runExplore } from "./explore.ts";
import { COVERAGE_USAGE, runCoverage } from "./coverage.ts";
import { INTENT_USAGE, runIntent } from "./intent.ts";
import { RUN_USAGE, runLocal } from "./local-run.ts";
import { RECORD_USAGE, runRecord, UsageError } from "./record.ts";

const USAGE = `Usage: pnpm intenzo <command>

Commands:
  record   Record a SavedPath on the PR (and base) app with the observation protocol
  explore  Let the navigator find a criterion's trigger on the PR app and save the path
  intent   Read a ticket's criteria with Spark 1.3 (intent.v1)
  coverage Map each criterion to the PR's changed files with Spark 1.3 (coverage.v1)
  run      Verify a PR app against a base app on this machine: record, then judge (--local)
${JOB_USAGE}

${RECORD_USAGE}

${EXPLORE_USAGE}

${INTENT_USAGE}

${COVERAGE_USAGE}

${RUN_USAGE}`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "record":
      return runRecord(rest);
    case "explore":
      return runExplore(rest);
    case "intent":
      return runIntent(rest);
    case "coverage":
      return runCoverage(rest);
    case "run":
      return runLocal(rest);
    case "job":
      return runJobCommand(rest);
    case undefined:
    case "help":
    case "--help":
      console.log(USAGE);
      return command === undefined ? 2 : 0;
    default:
      console.error(`unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  if (err instanceof UsageError) {
    console.error(`${err.message}\n\n${RECORD_USAGE}`);
    process.exitCode = 2;
  } else {
    throw err;
  }
}
