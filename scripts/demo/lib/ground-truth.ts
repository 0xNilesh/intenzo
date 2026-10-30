// What each demo branch of demo-shop does, criterion by criterion (ROADMAP T0.6, ARCHITECTURE
// §32). These are the labels every later check is scored against, so ground-truth.ts proves them
// on the real deployments before anything relies on them. They live here, not in demo-shop: the
// repo under test never carries an answer key for its own planted bugs.

export const BRANCHES = {
  correct: {
    branch: "pr/discount-correct",
    totals: ["$45.00", "$45.00", "$45.00"],
    afterReload: "$45.00",
    button: "Checkout",
    labels: "C1 pass, C2 pass, C3 pass, C4 pass; no unrequested change",
  },
  "almost-right": {
    branch: "pr/discount-almost-right",
    totals: ["$50.00", "$50.00", "$50.00"],
    afterReload: "$45.00",
    button: "Continue",
    labels:
      'C1 pass, C2 FAIL (total stale until reload), C3 pass, C4 pass; ⚠️ "Checkout" → "Continue"',
  },
} as const;
export type BranchKey = keyof typeof BRANCHES;

/** Readings after the trigger, in ms: the observation protocol's +0, +1 s and +3 s (§21.3). */
export const OFFSETS_MS = [0, 1000, 3000] as const;
export const DISCOUNT_GREEN = "#16a34a";
export const MUG_AMBER = "#f59e0b";
/** With $5.00 off the $50.00 seed cart, the discount is the chart's last slice, ~327°–360°. */
export const DISCOUNT_SLICE_DEG = 344;

export interface Expectation {
  check: string;
  criterion: string;
  expected: string;
}

export function expectationsFor(key: BranchKey): Expectation[] {
  const b = BRANCHES[key];
  return [
    { check: "discount line at Tt+0", criterion: "C1", expected: "Discount (SAVE10) −$5.00" },
    {
      check: "total at Tt+0/+1s/+3s, after reload",
      criterion: "C2",
      expected: `${b.totals.join(", ")}; reload ${b.afterReload}`,
    },
    { check: "OLD5 toast by Tt+1s", criterion: "C3", expected: "This code has expired" },
    {
      check: "chart at 344°, before → Tt+1s",
      criterion: "C4",
      expected: `${MUG_AMBER} → ${DISCOUNT_GREEN}`,
    },
    { check: "cart button label", criterion: "change", expected: b.button },
  ];
}

/** Vercel's alias for a branch's latest deployment of demo-shop. */
export function aliasUrl(branch: string): string {
  return `https://demo-shop-git-${branch.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-sumithprabhus-projects.vercel.app`;
}
