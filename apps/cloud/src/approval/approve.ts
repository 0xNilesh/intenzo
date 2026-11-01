// PM approval (§26.2, T5.5): Approve (PM) on a passing run's check run, or `/intenzo approve` in a
// comment on the pull request, records product approval as a commit status that names the
// approver. Only someone the repo's policy.approvers lists, with write access, can approve;
// anyone else gets a reply saying so.
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import type { Db } from "../db/db.ts";
import { repoConfig, type Repo } from "../db/repos.ts";
import { outbox, runGroups, runs } from "../db/schema.ts";
import type { GitHub } from "../github/api.ts";
import { enqueueEffects } from "../outbox/rows.ts";
import { shownRun } from "../report/model.ts";

/** The commit status an approval sets (§26.2). */
export const APPROVAL_CONTEXT = "Intenzo / product approval";

export type ApprovalResult = { approved: string } | { refused: string };

/** policy.approvers holds GitHub logins, with or without the @; logins ignore case, as GitHub's do. */
export function isListedApprover(approvers: readonly string[], login: string): boolean {
  const wanted = login.toLowerCase();
  return approvers.some((a) => a.replace(/^@/, "").toLowerCase() === wanted);
}

// docs.github.com/en/rest/collaborators/collaborators#get-repository-permissions-for-a-user
const Permission = z.looseObject({ permission: z.string(), role_name: z.string().optional() });
const WRITE = new Set(["admin", "maintain", "write"]);

/** Write access or more, as GitHub reports it for the repo; anyone else (or a 404) has none. */
export async function hasWriteAccess(github: GitHub, repo: string, login: string) {
  const answer = await github.get(
    `/repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`,
    Permission,
  );
  return answer !== null && (WRITE.has(answer.permission) || WRITE.has(answer.role_name ?? ""));
}

export interface ApprovalRequest {
  repo: Repo;
  /** The run the button was pressed on; a comment approves the run the PR's comment shows. */
  target: { runId: string } | { prNumber: number };
  login: string;
  /** A press of the button, or a typed command, which gets a reply when it can't be approved. */
  via: "button" | "comment";
  /** The webhook delivery, so a redelivered event replies once. */
  deliveryId: string;
}

export async function approve(
  db: Db,
  github: GitHub,
  request: ApprovalRequest,
): Promise<ApprovalResult> {
  const { repo, login } = request;
  const [group] =
    "runId" in request.target
      ? await db
          .select({ group: runGroups })
          .from(runs)
          .innerJoin(runGroups, eq(runs.runGroupId, runGroups.id))
          .where(eq(runs.id, request.target.runId))
          .then((rows) => rows.map((r) => r.group))
      : await db
          .select()
          .from(runGroups)
          .where(
            and(eq(runGroups.repoId, repo.id), eq(runGroups.prNumber, request.target.prNumber)),
          );
  if (!group) return { refused: "no Intenzo run on this pull request" };

  const reply = async (why: string, body: string): Promise<ApprovalResult> => {
    await db
      .insert(outbox)
      .values({
        groupId: group.id,
        effect: "reply",
        idemKey: `reply:${request.deliveryId}`,
        payloadJson: { kind: "reply", body },
      })
      .onConflictDoNothing({ target: outbox.idemKey });
    return { refused: why };
  };

  const groupRuns = await db.select().from(runs).where(eq(runs.runGroupId, group.id));
  const shown = shownRun(groupRuns);
  const pressed = "runId" in request.target ? request.target.runId : null;
  const run = pressed ? groupRuns.find((r) => r.id === pressed) : shown;
  // §26.2: Approve is offered only on a pass; the handler checks again, as for Send to agent.
  if (!run || run.id !== shown?.id || run.state !== "done" || run.outcome !== "pass") {
    const why = !run || run.id !== shown?.id ? "a newer run replaced it" : "the run didn't pass";
    // A stale button press is only logged; a typed command is answered.
    if (request.via === "button") return { refused: why };
    return reply(
      why,
      `@${login} there's nothing to approve yet: Intenzo's latest run on this pull request hasn't passed.`,
    );
  }
  const approvers = repoConfig(repo).policy.approvers;
  if (!isListedApprover(approvers, login)) {
    return reply(
      `${login} isn't in policy.approvers`,
      `@${login} isn't an approver for this repo (\`policy.approvers\` in \`.intenzo.yml\`).`,
    );
  }
  if (!(await hasWriteAccess(github, repo.fullName, login))) {
    return reply(
      `${login} has no write access`,
      `@${login} isn't an approver for this repo: approving needs write access.`,
    );
  }
  await db.transaction(async (tx) => {
    await tx
      .insert(outbox)
      .values({
        runId: run.id,
        groupId: group.id,
        effect: "approval",
        idemKey: `approve:${run.id}:${login.toLowerCase()}`,
        payloadJson: { kind: "approval", runId: run.id, login },
      })
      .onConflictDoNothing({ target: outbox.idemKey });
    // The comment and the run's check run show who approved.
    await tx
      .insert(outbox)
      .values({
        runId: run.id,
        groupId: group.id,
        effect: "check_run",
        idemKey: `check:${run.id}:approved:${login.toLowerCase()}`,
        payloadJson: { kind: "check_run", runId: run.id, status: "completed" },
      })
      .onConflictDoNothing({ target: outbox.idemKey });
    await enqueueEffects(tx, group.id, [{ kind: "comment", groupId: group.id }]);
  });
  return { approved: run.id };
}
