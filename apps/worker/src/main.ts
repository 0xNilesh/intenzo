// Entry point for the local `intenzo` CLI (and, from P2, VerifyJob execution on Modal).
//   pnpm intenzo <command> [options]
import { RECORD_USAGE, runRecord, UsageError } from "./record.ts";

const USAGE = `Usage: pnpm intenzo <command>

Commands:
  record   Record a SavedPath on the PR (and base) app with the observation protocol

${RECORD_USAGE}`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "record":
      return runRecord(rest);
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
