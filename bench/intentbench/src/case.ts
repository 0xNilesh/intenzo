// IntentBench's cases (ARCHITECTURE §31, T6.1): 12 demo-shop branches implementing 4 tickets, each
// with ground-truth labels per criterion that the ground-truth checks prove on its preview.
import { readdirSync, readFileSync } from "node:fs";

import { Criterion, CriterionId } from "@intenzo/core";
import { z } from "zod";

export const TICKETS = ["discount", "shipping", "limit", "undo"] as const;
export type TicketName = (typeof TICKETS)[number];

export const CaseKind = z.enum(["correct", "almost_right", "side_effect", "broken"]);
export type CaseKind = z.infer<typeof CaseKind>;

export const BenchCase = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9-]+$/),
    ticket: z.enum(TICKETS),
    /** The demo-shop branch: Vercel builds a preview of each. */
    branch: z.string().regex(/^bench\/[a-z0-9-]+$/),
    kind: CaseKind,
    /** §31: almost-right defects are planted by hand, never left to a model to make. */
    seeded: z.boolean(),
    split: z.enum(["tuning", "heldout"]),
    /** Ground truth per criterion, proven by the case's ground-truth checks. */
    labels: z.record(CriterionId, z.enum(["pass", "fail"])),
    /** What the branch changes that its ticket didn't ask for (side_effect cases only). */
    sideEffect: z
      .strictObject({ route: z.string().startsWith("/"), description: z.string().min(1) })
      .nullable(),
    /** How the branch was made, and what was planted or broken. */
    note: z.string().min(1),
  })
  .superRefine((c, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: "custom", message });
    const labels = Object.values(c.labels);
    if (c.seeded !== (c.kind === "almost_right"))
      issue("seeded is true for almost_right cases only");
    if ((c.sideEffect !== null) !== (c.kind === "side_effect"))
      issue("a sideEffect belongs to side_effect cases only");
    if ((c.kind === "correct" || c.kind === "side_effect") && labels.includes("fail"))
      issue(`a ${c.kind} case passes every criterion`);
    if (c.kind === "almost_right" && !labels.includes("fail"))
      issue("an almost_right case fails at least one criterion");
    if (c.kind === "almost_right" && !labels.includes("pass"))
      issue("an almost_right case passes at least one criterion");
    if (c.kind === "broken" && labels.includes("pass"))
      issue("a broken case fails every criterion");
  });
export type BenchCase = z.infer<typeof BenchCase>;

export interface Ticket {
  name: TicketName;
  title: string;
  /** The ticket as written, title included: what Muse Code implemented and arm A reads. */
  text: string;
  criteria: Criterion[];
}

const BENCH = new URL("../", import.meta.url);

export function loadTicket(name: TicketName): Ticket {
  const text = readFileSync(new URL(`tickets/${name}.md`, BENCH), "utf8");
  const criteria = z
    .array(Criterion)
    .parse(JSON.parse(readFileSync(new URL(`tickets/${name}.criteria.json`, BENCH), "utf8")));
  return { name, title: text.split("\n")[0]!.replace(/^#\s*/, ""), text, criteria };
}

/** Every case file, checked, with labels for exactly its ticket's criteria. */
export function loadCases(): BenchCase[] {
  const dir = new URL("cases/", BENCH);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      const parsed = BenchCase.parse(JSON.parse(readFileSync(new URL(f, dir), "utf8")));
      if (`${parsed.id}.json` !== f) throw new Error(`${f}: its id is ${parsed.id}`);
      const want = loadTicket(parsed.ticket).criteria.map((c) => c.id);
      const have = Object.keys(parsed.labels);
      if (want.join() !== have.join())
        throw new Error(`${f}: labels for ${have.join(", ")}, not ${want.join(", ")}`);
      return parsed;
    });
}

/** §31's stratified split, counted: how many of each kind in each part. */
export function splitCounts(cases: readonly BenchCase[]) {
  const counts = { tuning: {} as Record<string, number>, heldout: {} as Record<string, number> };
  for (const c of cases) counts[c.split][c.kind] = (counts[c.split][c.kind] ?? 0) + 1;
  return counts;
}
