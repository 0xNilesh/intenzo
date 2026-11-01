import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { describeHunk, diffSnapshots, dropExpected, snapshotLines, subtrees } from "./diff.ts";

// Recorded: /cart on main's preview and on the almost-right PR's, each with a fresh shopper (T5.6).
const fixture = (name: string) =>
  readFileSync(new URL(`../../../../fixtures/aria/${name}.yml`, import.meta.url), "utf8");
const MAIN = fixture("cart-main");
const ALMOST_RIGHT = fixture("cart-almost-right");
const USERS = ["shopper-763377", "shopper-55d37f"];

const lines = (text: string) => snapshotLines(text, { users: USERS });
const none = { base: new Set<number>(), pr: new Set<number>() };

describe("the aria diff (§24)", () => {
  it("doesn't shift what follows inserted content", () => {
    const base = lines('- main:\n  - heading "Cart"\n  - text: A\n  - text: B\n  - link "Pay"');
    const pr = lines(
      '- main:\n  - heading "Cart"\n  - text: A\n  - form "Code":\n    - textbox "Code"\n  - text: B\n  - link "Pay"',
    );
    const hunks = diffSnapshots(base, pr);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({ removed: [], landmark: "main" });
    expect(hunks[0]!.added.map((l) => l.text)).toEqual(['- form "Code":', '- textbox "Code"']);
  });

  it("masks the ephemeral user, and the amounts, dates and times each lane has its own of", () => {
    const masked = snapshotLines(
      "- text: Signed in as shopper-763377 (shopper-763377@example.com) on 2026-11-01 at 10:04 pm, $1,050.00 −$5.00",
      { users: ["shopper-763377"] },
    );
    expect(masked[0]!.text).toBe(
      "- text: Signed in as <user> (<email>) on <date> at <time>, <amount> <amount>",
    );
    // main and almost-right differ in the signed-in shopper: masked, so no hunk for it.
    const hunks = diffSnapshots(lines(MAIN), lines(ALMOST_RIGHT));
    expect(hunks.some((h) => describeHunk(h).includes("Signed in"))).toBe(false);
  });

  it("finds the discount form and the renamed link between main and almost-right", () => {
    const hunks = diffSnapshots(lines(MAIN), lines(ALMOST_RIGHT));
    expect(hunks.map(describeHunk)).toEqual([
      'added form "Discount code" / text: Discount code / textbox "Discount code" / button "Apply"',
      'link "Checkout" → "Continue"',
    ]);
    expect(hunks.map((h) => h.landmark)).toEqual(["main", 'region "Order summary"']);
  });

  it("drops what a criterion's trigger or watched element touches, and keeps the rest", () => {
    const base = lines(MAIN);
    const pr = lines(ALMOST_RIGHT);
    const hunks = diffSnapshots(base, pr);
    // The trigger fills textbox "Discount code" and clicks button "Apply" (on the PR side).
    const trigger = pr.flatMap((l, k) =>
      /textbox "Discount code"|button "Apply"/.test(l.text) ? [k] : [],
    );
    const kept = dropExpected(hunks, { base: new Set(), pr: subtrees(pr, trigger) }, base, pr);
    expect(kept.map(describeHunk)).toEqual(['link "Checkout" → "Continue"']);
  });

  it("drops a change inside C2's watched element, but not one elsewhere in its region", () => {
    const base = lines(
      '- region "Order summary":\n  - status "Order total":\n    - text: Total\n  - link "Checkout"',
    );
    const pr = lines(
      '- region "Order summary":\n  - status "Order total":\n    - text: Total (incl. discount)\n  - link "Continue"',
    );
    // Neighbouring changes make one hunk…
    const hunks = diffSnapshots(base, pr);
    expect(hunks.map(describeHunk)).toEqual([
      'text: Total / link "Checkout" → text: Total (incl. discount) / link "Continue"',
    ]);
    // …and the line inside the watched element goes, while the link beside it stays.
    const watched = (ls: typeof base) =>
      subtrees(ls, [ls.findIndex((l) => l.text.startsWith('- status "Order total"'))]);
    const kept = dropExpected(hunks, { base: watched(base), pr: watched(pr) }, base, pr);
    expect(kept.map(describeHunk)).toEqual(['link "Checkout" → "Continue"']);
  });

  it("finds nothing between two identical pages", () => {
    expect(diffSnapshots(lines(MAIN), lines(MAIN))).toEqual([]);
    expect(dropExpected([], none, [], [])).toEqual([]);
  });
});
