import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { recordCriterion } from "../browser/record.ts";
import { html, startServer, type TestServer } from "../browser/testing.ts";
import { type ModelRequest, textOf } from "../models/port.ts";
import { scriptedPort } from "../models/scripted.ts";
import { Criterion, DEFAULT_DENY_TEXT, type SavedPath } from "../schema/index.ts";
import { explore } from "./explore.ts";
import { recordWithPath } from "./replay.ts";

// The cart's Apply button has been renamed "Redeem" since the path was saved.
const CART = `
<main>
  <p data-testid="total">$50.00</p>
  <form aria-label="Discount code" onsubmit="event.preventDefault(); document.querySelector('[data-testid=total]').textContent = '$45.00'">
    <label>Discount code <input></label>
    <button>Redeem</button>
  </form>
</main>`;

const criterion = Criterion.parse({
  id: "C2",
  text: "The total drops",
  trigger: "Apply the discount code SAVE10",
  setup: [],
  expected: "The total reads $45.00",
  watch: ["order total"],
  kind: "ui_behavior",
  persistence: false,
  inferred: false,
});

const cached: SavedPath = {
  criterionId: "C2",
  setup: [{ op: "goto", path: "/cart" }],
  trigger: [
    { op: "fill", target: { by: "role", role: "textbox", name: "Discount code" }, value: "SAVE10" },
    { op: "click", target: { by: "role", role: "button", name: "Apply" } },
  ],
  watch: [
    { label: "order total", scope: "element", target: { by: "testId", id: "total" } },
    {
      label: "Discount code",
      scope: "region",
      target: { by: "role", role: "form", name: "Discount code" },
    },
  ],
  portable: true,
};

let browser: Browser;
let app: TestServer;
let dir: string;

beforeAll(async () => {
  browser = await chromium.launch();
  app = await startServer("127.0.0.1", (_req, res) => html(res, CART));
  dir = mkdtempSync(join(tmpdir(), "intenzo-replay-"));
});
afterAll(async () => {
  await browser.close();
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

const ref = (request: ModelRequest<unknown>, line: RegExp) =>
  /\[ref=([a-z0-9]+)\]/.exec(
    textOf(request.messages.at(-1)!)
      .split("\n")
      .find((l) => line.test(l))!,
  )![1]!;

describe("recordWithPath on a renamed button", () => {
  it("fails the cached replay, re-explores, and records a new take that completes", async () => {
    const model = scriptedPort([
      (r) => ({
        thought: "",
        phase: "trigger",
        action: { op: "fill", ref: ref(r, /textbox "Discount code"/), value: "SAVE10" },
        status: "continue",
      }),
      (r) => ({
        thought: "Apply is now called Redeem",
        phase: "trigger",
        action: { op: "click", ref: ref(r, /button "Redeem"/) },
        status: "trigger_done",
        watch: [{ label: "order total", ref: ref(r, /\$50\.00/) }],
      }),
    ]);
    const takeDir = (take: number) => join(dir, "C2", "pr", `take-${take}`);
    const outcome = await recordWithPath({
      cached,
      explore: () =>
        explore(browser, {
          origin: app.origin,
          criterion,
          model,
          denyText: [...DEFAULT_DENY_TEXT],
          startPath: "/cart",
        }),
      record: (path, take) =>
        recordCriterion(browser, {
          origin: app.origin,
          side: "pr",
          criterion,
          path,
          outDir: takeDir(take),
        }),
      laneOf: (recording) => recording.lane,
    });

    expect(outcome).toMatchObject({ kind: "recorded", source: "re_explored", take: 2 });
    if (outcome.kind !== "recorded") return;
    expect(outcome.path.trigger.at(-1)).toEqual({
      op: "click",
      target: { by: "role", role: "button", name: "Redeem" },
    });
    // Take 1 is the broken replay, kept; take 2 is the new recording.
    expect(existsSync(join(takeDir(1), "lane.json"))).toBe(true);
    expect(outcome.recording.lane.status).toBe("completed");
    const totals = outcome.recording.lane.readings.filter(
      (r) => r.label === "order total" && r.phase === "post",
    );
    expect(totals.map((r) => r.value)).toEqual(["$45.00", "$45.00", "$45.00"]);
  });
});
