import { describe, expect, it } from "vitest";

import { ContextBundle, type Criterion, type CriterionSet } from "../schema/index.ts";
import {
  combinedHash,
  countsTowardOutcome,
  intentSources,
  MAX_RUN_CRITERIA,
  mergeIntents,
  parsePrIntent,
  prCriteriaTicket,
} from "./pr-intent.ts";

const TEMPLATE = `## Intent
Closes #5
Closes #7

## Acceptance criteria
<!-- Optional: extra checks this PR claims. Reported as "from the PR (unverified)". -->
- [ ] After Undo, the header's cart count shows the restored items

## Test hints
<!-- Optional, this PR only. Overrides .intenzo.yml. -->
- start: /cart
- data: valid discount code: SAVE10
`;

describe("parsePrIntent", () => {
  it("reads the three sections of the PR template", () => {
    expect(parsePrIntent("Discount codes and undo", TEMPLATE)).toEqual({
      tickets: [5, 7],
      criteria: ["After Undo, the header's cart count shows the restored items"],
      hints: { start: "/cart", data: ["valid discount code: SAVE10"] },
      structured: true,
    });
  });

  it("falls back to the first linked ticket when there's no Intent section", () => {
    expect(parsePrIntent("Discount codes", "Closes #5. See #9 too.")).toMatchObject({
      tickets: [5],
      structured: false,
    });
    expect(parsePrIntent("Discount codes (#7)", null)).toMatchObject({
      tickets: [7],
      criteria: [],
    });
    expect(parsePrIntent("Tidy up", "No ticket here")).toMatchObject({
      tickets: [],
      structured: false,
    });
  });

  it("takes every ticket line form, once each, never the PR itself, at most 5", () => {
    const body = `### intent
- Fixes #5
- Resolves https://github.com/acme/shop/issues/7
- Refs acme/shop#9
- Closes #5
- Closes #12 (this PR)
- Relates to other/repo#3
- #20
- #21
- #22`;
    expect(parsePrIntent("x", body, { self: 12, repo: "acme/shop" }).tickets).toEqual([
      5, 7, 9, 20, 21,
    ]);
  });

  it("ignores template comments and keeps only real bullets, capped", () => {
    const body = `## Acceptance criteria\n<!-- - [ ] not this -->\nprose isn't a criterion\n${Array.from({ length: 12 }, (_, i) => `${i + 1}. check ${i + 1}`).join("\n")}`;
    const { criteria } = parsePrIntent("x", body);
    expect(criteria).toHaveLength(10);
    expect(criteria[0]).toBe("check 1");
  });

  it("only accepts a start path on the app's own origin", () => {
    expect(parsePrIntent("x", "## Test hints\nstart: https://evil.example\ndata: a").hints).toEqual(
      { data: ["a"] },
    );
    expect(parsePrIntent("x", "## Test hints\n- start: //evil.example").hints).toEqual({
      data: [],
    });
  });
});

const criterion = (id: string, text: string): Criterion => ({
  id,
  text,
  trigger: "Apply SAVE10",
  setup: [],
  expected: "The total drops",
  watch: [],
  kind: "ui_behavior",
  persistence: false,
  inferred: false,
});
const set = (n: number, prefix: string, extra: Partial<CriterionSet> = {}): CriterionSet => ({
  criteria: Array.from({ length: n }, (_, i) => criterion(`C${i + 1}`, `${prefix} ${i + 1}`)),
  intentSource: "linked_issue",
  ticketHash: prefix
    .padEnd(64, "0")
    .replace(/[^0-9a-f]/g, "a")
    .slice(0, 64),
  ...extra,
});

describe("mergeIntents", () => {
  it("renumbers across sources and tags each criterion with its source", () => {
    const merged = mergeIntents([
      { source: "#5", set: set(2, "discount") },
      { source: "#7", set: set(1, "undo", { intentSource: "linked_issue_video" }) },
      { source: "pr", set: set(1, "pr", { intentSource: "pr_body" }) },
    ]);
    expect(merged.criteria.map((c) => `${c.id} ${c.source} ${c.text}`)).toEqual([
      "C1 #5 discount 1",
      "C2 #5 discount 2",
      "C3 #7 undo 1",
      "C4 pr pr 1",
    ]);
    expect(merged.intentSource).toBe("linked_issue_video");
    expect(merged.ticketHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps a single ticket's hash, so its cached intent is reused as before", () => {
    const one = set(3, "discount");
    expect(mergeIntents([{ source: "#5", set: one }]).ticketHash).toBe(one.ticketHash);
  });

  it("changes the hash when any source changes", () => {
    const a = mergeIntents([
      { source: "#5", set: set(1, "a") },
      { source: "pr", set: set(1, "b") },
    ]);
    const b = mergeIntents([
      { source: "#5", set: set(1, "a") },
      { source: "pr", set: set(1, "c") },
    ]);
    expect(a.ticketHash).not.toBe(b.ticketHash);
  });

  it("cuts the PR's own criteria first when there are too many", () => {
    const merged = mergeIntents([
      { source: "#5", set: set(6, "t5") },
      { source: "#7", set: set(5, "t7") },
      { source: "pr", set: set(4, "pr") },
    ]);
    expect(merged.criteria).toHaveLength(MAX_RUN_CRITERIA);
    expect(merged.criteria.filter((c) => c.source === "pr")).toHaveLength(1);
  });

  it("only the tickets' criteria count toward the outcome", () => {
    expect(countsTowardOutcome({ source: "#5" })).toBe(true);
    expect(countsTowardOutcome({})).toBe(true);
    expect(countsTowardOutcome({ source: "pr" })).toBe(false);
  });
});

describe("intentSources", () => {
  const base = ContextBundle.parse({
    pr: {
      number: 30,
      title: "Discount and undo",
      body: "",
      headSha: "a".repeat(40),
      baseRef: "main",
      isFork: false,
      isBot: false,
    },
    ticket: null,
    images: [],
    media: [],
    mediaUrls: ["https://blob.example/t5.mp4"],
    diff: { files: [] },
    hints: null,
  });
  const ticket = (ref: string, video: number | null) => ({
    ref,
    title: `Ticket ${ref}`,
    body: "Body",
    comments: [],
    video,
  });

  it("reads each ticket with its own recording, then the PR's criteria as a checklist", () => {
    const sources = intentSources({
      ...base,
      tickets: [ticket("#5", 0), ticket("#7", null)],
      prCriteria: ["The badge updates"],
    });
    expect(sources.map((s) => [s.source, s.videoUrl ?? null, s.intentSource])).toEqual([
      ["#5", "https://blob.example/t5.mp4", "linked_issue"],
      ["#7", null, "linked_issue"],
      ["pr", null, "pr_body"],
    ]);
    expect(sources[2]!.ticket.body).toBe("## Acceptance criteria\n- [ ] The badge updates");
  });

  it("reads a bundle from before several intents through its single ticket", () => {
    const sources = intentSources({
      ...base,
      ticket: { source: "github_issue", ref: "#5", title: "T", body: "B", comments: [] },
    });
    expect(sources).toEqual([
      {
        source: "#5",
        ticket: { ref: "#5", title: "T", body: "B", comments: [] },
        videoUrl: "https://blob.example/t5.mp4",
        intentSource: "linked_issue",
      },
    ]);
  });

  it("falls back to the PR's description when nothing is linked", () => {
    expect(intentSources({ ...base, mediaUrls: [] }).map((s) => s.source)).toEqual(["PR body"]);
  });
});

describe("combinedHash", () => {
  it("matches mergeIntents, so the Cloud's lookup finds the worker's intent", () => {
    const parts = [
      { source: "#5", set: set(1, "a") },
      { source: "pr", set: set(1, "b") },
    ];
    expect(combinedHash(parts.map((p) => ({ source: p.source, hash: p.set.ticketHash })))).toBe(
      mergeIntents(parts).ticketHash,
    );
    expect(prCriteriaTicket("T", ["x"]).ref).toBe("PR");
  });
});
