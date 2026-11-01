import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { scriptedPort } from "../models/scripted.ts";
import { classifyChanges, reportable } from "./classify.ts";
import { diffSnapshots, snapshotLines } from "./diff.ts";

const fixture = (name: string) =>
  readFileSync(new URL(`../../../../fixtures/aria/${name}.yml`, import.meta.url), "utf8");
const users = { users: ["shopper-763377", "shopper-55d37f"] };
// main → almost-right on /cart: h1 the discount form, h2 the renamed link.
const hunks = diffSnapshots(
  snapshotLines(fixture("cart-main"), users),
  snapshotLines(fixture("cart-almost-right"), users),
);
const criteria = [
  { id: "C1", text: "SAVE10 adds a discount line", expected: "A line Discount (SAVE10) −$5.00" },
  { id: "C2", text: "The total drops to $45.00", expected: "Total $45.00 within 1 s" },
];

describe("changes.v1 (§24)", () => {
  it("reports what no criterion explains, in the code's own words, when the model is sure", async () => {
    const port = scriptedPort([
      {
        hunks: [
          { id: "h1", explainedBy: "C1", description: "the discount form", confidence: 0.95 },
          { id: "h2", explainedBy: null, description: "Checkout renamed", confidence: 0.92 },
        ],
      },
    ]);
    const result = await classifyChanges(port, { route: "/cart", criteria, hunks });
    expect(result).toMatchObject({
      changes: [{ route: "/cart", description: 'link "Checkout" → "Continue"', confidence: 0.92 }],
      error: null,
    });
    expect(port.requests[0]).toMatchObject({
      stage: "changes",
      model: "muse-spark-1.3",
      promptVersion: "changes.v1",
      reasoningEffort: "low",
    });
    const ask = port.requests[0]!.messages[1]!.content as string;
    expect(ask).toContain('<untrusted source="criteria">');
    expect(ask).toContain('<untrusted source="hunks">');
    expect(ask).toContain('h2 on /cart, in region "Order summary":');
    expect(ask).toContain('  base: - link "Checkout":');
  });

  it("leaves out what it isn't sure of, and says when the call failed", async () => {
    const unsure = scriptedPort([
      { hunks: [{ id: "h2", explainedBy: null, description: "x", confidence: 0.5 }] },
    ]);
    expect((await classifyChanges(unsure, { route: "/cart", criteria, hunks })).changes).toEqual(
      [],
    );
    const broken = scriptedPort([]);
    const failed = await classifyChanges(broken, { route: "/cart", criteria, hunks });
    expect(failed).toMatchObject({ changes: [] });
    expect(failed.error).toContain("ran out of replies");
  });

  it("asks nothing when there's nothing to classify, and reports the three surest", async () => {
    const port = scriptedPort([]);
    expect(await classifyChanges(port, { route: "/cart", criteria, hunks: [] })).toEqual({
      changes: [],
      costUsd: 0,
      error: null,
    });
    expect(port.requests).toHaveLength(0);
    const changes = [0.71, 0.99, 0.8, 0.9].map((confidence, i) => ({
      route: "/cart",
      description: `change ${i}`,
      confidence,
    }));
    expect(reportable(changes).map((c) => c.confidence)).toEqual([0.99, 0.9, 0.8]);
  });
});
