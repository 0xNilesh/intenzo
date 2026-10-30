import type { Variant } from "./fixture/server.ts";
import type { Criterion, Step, Target, WatchTarget } from "./lib/schema.ts";

/** The right answer for a clip. `ambiguous` clips have none; they're reported, not scored. */
export type Label = "pass" | "fail" | "ambiguous";

export interface Clip {
  id: string;
  label: Label;
  /** Which planted behavior of the fixture shop is recorded (fixture/shop.html). */
  variant: Variant;
  /** Why the label is right, in one sentence (fixture/shop.browser.test.ts proves the behavior). */
  truth: string;
  criterion: Criterion;
  setup: Step[];
  /** The last trigger step defines Tt (§21.3). */
  trigger: Step[];
  watch: WatchTarget[];
}

const testId = (id: string): Target => ({ by: "testId", id });
const fillCode = (code: string): Step[] => [
  { op: "fill", target: testId("discount-input"), value: code },
];
const pressApply: Step[] = [{ op: "click", target: testId("apply") }];
const watch = (label: string, target: Target): WatchTarget => ({ label, scope: "element", target });

const CART_SETUP = ["The cart holds two items worth $50.00 in total"];

const DISCOUNT_LINE: Criterion = {
  id: "C1",
  text: "Applying the code SAVE10 adds a discount line of −$5.00 to the order summary.",
  trigger: "Type SAVE10 into the discount code field and press Apply",
  setup: CART_SETUP,
  expected: "A discount line showing −$5.00 appears in the order summary.",
  watch: ["discount line"],
  kind: "ui_behavior",
  persistence: false,
  inferred: false,
};

const TOTAL_RIGHT_AWAY: Criterion = {
  id: "C2",
  text: "Applying SAVE10 updates the order total to $45.00 right away, and it stays $45.00 after a reload.",
  trigger: "Type SAVE10 into the discount code field and press Apply",
  setup: CART_SETUP,
  expected:
    "The order total reads $45.00 within 1 s of pressing Apply, and still reads $45.00 after reloading the page.",
  watch: ["order total"],
  kind: "ui_behavior",
  persistence: true,
  timingMs: 1000,
  inferred: false,
};

const EXPIRED_ERROR: Criterion = {
  id: "C3",
  text: "Applying the expired code OLD5 shows the error 'This code has expired'.",
  trigger: "Type OLD5 into the discount code field and press Apply",
  setup: CART_SETUP,
  expected: "An error message saying 'This code has expired' appears.",
  watch: ["error message"],
  kind: "ui_behavior",
  persistence: false,
  inferred: false,
};

const EXACT_TOTAL: Criterion = {
  id: "C4",
  text: "SAVE10 takes exactly 10% off the $50.00 cart, so the order total becomes $45.00.",
  trigger: "Type SAVE10 into the discount code field and press Apply",
  setup: CART_SETUP,
  expected: "The order total reads $45.00 after pressing Apply.",
  watch: ["order total"],
  kind: "ui_behavior",
  persistence: false,
  inferred: false,
};

const TEN_PERCENT: Criterion = {
  id: "C5",
  text: "SAVE10 gives 10% off: the order summary shows a discount line of −$5.00 and a total of $45.00.",
  trigger: "Type SAVE10 into the discount code field and press Apply",
  setup: CART_SETUP,
  expected: "The discount line shows −$5.00 and the order total reads $45.00.",
  watch: ["discount line", "order total"],
  kind: "ui_behavior",
  persistence: false,
  inferred: false,
};

const CLEAR_CONFIRMATION: Criterion = {
  id: "C6",
  text: "After applying SAVE10, the shopper sees a clear confirmation that the code was accepted.",
  trigger: "Type SAVE10 into the discount code field and press Apply",
  setup: CART_SETUP,
  expected: "A clear confirmation that SAVE10 was accepted is visible after pressing Apply.",
  watch: ["apply button"],
  kind: "ui_behavior",
  persistence: false,
  inferred: false,
};

const TOTAL_QUICKLY: Criterion = {
  id: "C7",
  text: "After applying SAVE10, the order total updates quickly to $45.00.",
  trigger: "Type SAVE10 into the discount code field and press Apply",
  setup: CART_SETUP,
  expected: "The order total changes to $45.00 quickly after pressing Apply.",
  watch: ["order total"],
  kind: "ui_behavior",
  persistence: false,
  inferred: false,
};

const LINE = watch("discount line", testId("discount-line"));
const TOTAL = watch("order total", testId("total"));
const ERROR = watch("error message", { by: "role", role: "alert" });
const APPLY = watch("apply button", testId("apply"));

const save10 = { setup: fillCode("SAVE10"), trigger: pressApply };
const old5 = { setup: fillCode("OLD5"), trigger: pressApply };

/** The ten go/no-go clips (ROADMAP T0.3): 4 correct, 4 almost-right, 2 ambiguous. */
export const CLIPS: readonly Clip[] = [
  {
    id: "line-correct",
    label: "pass",
    variant: "correct",
    truth: "The discount line shows −$5.00 right after Apply.",
    criterion: DISCOUNT_LINE,
    ...save10,
    watch: [LINE],
  },
  {
    id: "total-correct",
    label: "pass",
    variant: "correct",
    truth: "The total reads $45.00 at +0 s and still after a reload.",
    criterion: TOTAL_RIGHT_AWAY,
    ...save10,
    watch: [TOTAL],
  },
  {
    id: "expired-correct",
    label: "pass",
    variant: "correct",
    truth: "An alert 'This code has expired' appears right after Apply.",
    criterion: EXPIRED_ERROR,
    ...old5,
    watch: [ERROR],
  },
  {
    id: "line-on-stale-build",
    label: "pass",
    variant: "stale-total",
    truth:
      "This build leaves the total stale, but the criterion is only about the discount line, which shows −$5.00.",
    criterion: DISCOUNT_LINE,
    ...save10,
    watch: [LINE],
  },
  {
    id: "total-stale",
    label: "fail",
    variant: "stale-total",
    truth: "The total stays $50.00 at +0, +1 and +3 s, and only reads $45.00 after a reload.",
    criterion: TOTAL_RIGHT_AWAY,
    ...save10,
    watch: [TOTAL],
  },
  {
    id: "total-off-by-cent",
    label: "fail",
    variant: "off-by-cent",
    truth: "The total reads $45.01, not $45.00.",
    criterion: EXACT_TOTAL,
    ...save10,
    watch: [TOTAL],
  },
  {
    id: "discount-wrong-percent",
    label: "fail",
    variant: "wrong-percent",
    truth: "SAVE10 takes 15% off: the line shows −$7.50 and the total $42.50.",
    criterion: TEN_PERCENT,
    ...save10,
    watch: [LINE, TOTAL],
  },
  {
    id: "expired-missing",
    label: "fail",
    variant: "missing-error",
    truth: "Nothing at all appears after applying OLD5.",
    criterion: EXPIRED_ERROR,
    ...old5,
    watch: [ERROR],
  },
  {
    id: "confirm-quiet",
    label: "ambiguous",
    variant: "quiet-confirm",
    truth:
      "No message appears; the discount applies and the button turns into a grey, disabled 'Applied'. Whether that is a clear confirmation is a judgment call.",
    criterion: CLEAR_CONFIRMATION,
    ...save10,
    watch: [APPLY],
  },
  {
    id: "total-slow",
    label: "ambiguous",
    variant: "slow-total",
    truth:
      "The total reads 'Updating…' for 2 s, then $45.00. 'Quickly' doesn't say how fast is fast enough.",
    criterion: TOTAL_QUICKLY,
    ...save10,
    watch: [TOTAL],
  },
];
