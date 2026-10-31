// What the worker is handed on stdin (§8): a VerifyJob, or a sleep job that only exercises the job
// protocol and, in T2.5b, the Modal shim's cancellation.
import { VerifyJob } from "@intenzo/core";
import { z } from "zod";

export const SleepJob = z.object({
  type: z.literal("sleep"),
  jobId: z.uuid(),
  runId: z.uuid(),
  deadlineAt: z.iso.datetime(),
  callback: z.object({ baseUrl: z.url(), token: z.string().min(1) }),
  /** How long it sleeps, asking the Cloud between naps whether to go on. */
  seconds: z.number().positive().max(900),
  /** How often it asks /alive. */
  aliveEverySeconds: z.number().positive().max(60).default(5),
});
export type SleepJob = z.infer<typeof SleepJob>;

/** Reports the demo ticket's criteria with fixed verdicts (stub.ts) until the judges arrive. */
export const StubJob = SleepJob.omit({ seconds: true, aliveEverySeconds: true }).extend({
  type: z.literal("stub"),
});
export type StubJob = z.infer<typeof StubJob>;

export const JobPayload = z.discriminatedUnion("type", [VerifyJob, SleepJob, StubJob]);
export type JobPayload = z.infer<typeof JobPayload>;
