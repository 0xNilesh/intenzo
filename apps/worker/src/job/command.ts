// `intenzo job [file]`: runs one job (§8), read from the file or from stdin, which is how the Modal
// shim hands it over (T2.5b). The exit code tells the shim whether to report `failed` itself.
import { readFile } from "node:fs/promises";
import { text } from "node:stream/consumers";

import { runJob } from "./run.ts";

export const JOB_USAGE = `  job [file]   Run one job (ARCHITECTURE §8), read from the file or stdin, reporting
               to the Cloud (§9). Exit 0: finished; 1: failed (reported); 3: the Cloud
               said the job isn't current (410), so it stopped.`;

export async function runJobCommand(args: readonly string[]): Promise<number> {
  const [file] = args;
  const payload = JSON.parse(file ? await readFile(file, "utf8") : await text(process.stdin));
  return runJob(payload);
}
