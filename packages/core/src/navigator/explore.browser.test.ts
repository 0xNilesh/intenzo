import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { recordCriterion } from "../browser/record.ts";
import { html, startServer, type TestServer } from "../browser/testing.ts";
import { scriptedPort } from "../models/scripted.ts";
import type { ModelRequest } from "../models/port.ts";
import { Criterion, DEFAULT_DENY_TEXT } from "../schema/index.ts";
import { explore, startPathFor } from "./explore.ts";

// A tiny shop: the home page links to the cart; the cart has a total, a discount form (SAVE10
// takes 10% off, OLD5 shows a toast) and a "Delete cart" button the guard must refuse.
const HOME = `<header><nav aria-label="Main"><a href="/cart">Cart (2)</a></nav></header><main><h1>Shop</h1></main>`;
const CART = `
<main>
  <h1>Cart</h1>
  <p>Total</p>
  <p data-testid="total">$50.00</p>
  <form aria-label="Discount code" onsubmit="event.preventDefault(); apply()">
    <label>Discount code <input name="code"></label>
    <button>Apply</button>
  </form>
  <button>Delete cart</button>
</main>
<script>
  function apply() {
    const code = document.querySelector("input").value;
    if (code === "SAVE10") document.querySelector("[data-testid=total]").textContent = "$45.00";
    else document.body.insertAdjacentHTML("beforeend", '<div role="alert">This code has expired</div>');
  }
</script>`;

const criterion = Criterion.parse({
  id: "C2",
  text: "The total drops to $45.00",
  trigger: "Apply the discount code SAVE10 on the cart",
  setup: ["the cart has items"],
  expected: "The total reads $45.00",
  watch: ["order total"],
  kind: "ui_behavior",
  persistence: false,
  inferred: false,
});

let browser: Browser;
let app: TestServer;
let dir: string;

beforeAll(async () => {
  browser = await chromium.launch();
  app = await startServer("127.0.0.1", (req, res) => html(res, req.path === "/cart" ? CART : HOME));
  dir = mkdtempSync(join(tmpdir(), "intenzo-explore-"));
});
afterAll(async () => {
  await browser.close();
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The ref of the outline line matching `line`, from the step's prompt. */
function ref(request: ModelRequest<unknown>, line: RegExp): string {
  const prompt = request.messages.at(-1)!.content;
  const found = prompt.split("\n").find((l) => line.test(l));
  if (!found) throw new Error(`no outline line matches ${line}`);
  return /\[ref=([a-z0-9]+)\]/.exec(found)![1]!;
}

const act = (
  phase: "setup" | "trigger",
  action: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) => ({
  thought: "",
  phase,
  action,
  status: "continue",
  ...extra,
});
const base = { origin: "", criterion, denyText: [...DEFAULT_DENY_TEXT], startPath: "/" };

describe("explore", () => {
  it("reaches the trigger and saves a path that replays to the same readings", async () => {
    const model = scriptedPort([
      act("setup", { op: "goto", path: "/cart" }),
      (r) =>
        act("trigger", { op: "fill", ref: ref(r, /textbox "Discount code"/), value: "SAVE10" }),
      (r) =>
        act(
          "trigger",
          { op: "click", ref: ref(r, /button "Apply"/) },
          {
            status: "trigger_done",
            watch: [{ label: "order total", ref: ref(r, /\$50\.00/) }],
          },
        ),
    ]);
    const result = await explore(browser, { ...base, origin: app.origin, model });
    expect(result.status).toBe("found");
    if (result.status !== "found") return;
    expect(result.path).toEqual({
      criterionId: "C2",
      setup: [
        { op: "goto", path: "/" },
        { op: "goto", path: "/cart" },
      ],
      trigger: [
        {
          op: "fill",
          target: { by: "role", role: "textbox", name: "Discount code" },
          value: "SAVE10",
        },
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
    });
    expect(result.steps.map((s) => s.ok)).toEqual([true, true, true]);
    // The model never saw what should happen.
    for (const request of model.requests)
      expect(JSON.stringify(request.messages)).not.toContain("$45.00");

    // Exploration is never the evidence: the saved path replays cleanly in the recorder.
    const recording = await recordCriterion(browser, {
      origin: app.origin,
      side: "pr",
      criterion,
      path: result.path,
      outDir: join(dir, "C2", "pr", "take-1"),
    });
    expect(recording.lane.status).toBe("completed");
    const totals = recording.lane.readings.filter(
      (r) => r.label === "order total" && r.phase === "post",
    );
    expect(totals.map((r) => r.value)).toEqual(["$45.00", "$45.00", "$45.00"]);
  });

  it("feeds a refusal back to the model and keeps going", async () => {
    const model = scriptedPort([
      act("setup", { op: "goto", path: "/cart" }),
      (r) => act("setup", { op: "click", ref: ref(r, /button "Delete cart"/) }),
      { thought: "Nothing else to try", phase: "setup", status: "give_up", reason: "blocked" },
    ]);
    const result = await explore(browser, { ...base, origin: app.origin, model });
    expect(result).toMatchObject({ status: "setup_failed" });
    expect(result.steps[1]).toMatchObject({ ok: false });
    expect(result.steps[1]!.result).toMatch(/^Refused: .*"Delete cart".*denylist/);
    expect(model.requests[2]!.messages.at(-1)!.content).toContain("Last result: Refused:");
  });

  it("classifies giving up: no trigger control is trigger_absent, anything else setup_failed", async () => {
    const absent = await explore(browser, {
      ...base,
      origin: app.origin,
      model: scriptedPort([
        {
          thought: "No code field here",
          phase: "trigger",
          status: "give_up",
          reason: "trigger_not_found",
        },
      ]),
    });
    expect(absent).toMatchObject({ status: "trigger_absent" });
    const unmet = await explore(browser, {
      ...base,
      origin: app.origin,
      model: scriptedPort([
        {
          thought: "Cart is empty",
          phase: "setup",
          status: "give_up",
          reason: "precondition_unmet",
        },
      ]),
    });
    expect(unmet).toMatchObject({ status: "setup_failed" });
    expect(unmet.status !== "found" && unmet.reason).toMatch(/^precondition_unmet/);
  });

  it("stops when the step budget runs out", async () => {
    const model = scriptedPort(() => act("setup", { op: "wait", ms: 50 }));
    const result = await explore(browser, {
      ...base,
      origin: app.origin,
      model,
      budget: { steps: 3, ms: 60_000 },
    });
    expect(result).toMatchObject({ status: "setup_failed", reason: "budget: 3 steps ran out" });
    expect(result.steps).toHaveLength(3);
  });

  it("tells the model when its reply is unusable, and stops after three in a row", async () => {
    const model = scriptedPort(() => ({ thought: "", phase: "setup", status: "continue" }));
    const result = await explore(browser, { ...base, origin: app.origin, model });
    expect(result).toMatchObject({
      status: "setup_failed",
      reason: "the model failed 3 times in a row",
    });
    expect(model.requests[1]!.messages.at(-1)!.content).toContain(
      "Last result: Your reply couldn't be used",
    );
  });
});

describe("startPathFor", () => {
  it("prefers the ticket's start path, then the best-matching route, then the default", () => {
    expect(startPathFor({ criterion, reproStartPath: "/products", routes: ["/cart"] })).toBe(
      "/products",
    );
    expect(startPathFor({ criterion, routes: ["/products", "/cart", "/checkout"] })).toBe("/cart");
    expect(startPathFor({ criterion, routes: ["/about"], fallback: "/" })).toBe("/");
  });
});
