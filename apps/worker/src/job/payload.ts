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
});
export type SleepJob = z.infer<typeof SleepJob>;

export const JobPayload = z.discriminatedUnion("type", [VerifyJob, SleepJob]);
export type JobPayload = z.infer<typeof JobPayload>;
