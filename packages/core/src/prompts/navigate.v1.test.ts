import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { Criterion } from "../schema/index.ts";
import { NAVIGATE_JSON_SCHEMA, NavigateReply, renderNavigate } from "./navigate.v1.ts";

const c2 = Criterion.parse(
  JSON.parse(
    readFileSync(resolve(import.meta.dirname, "../../../../fixtures/criteria/C2.json"), "utf8"),
  ),
);
const nulls = {
  ref: null,
  path: null,
  value: null,
  option: null,
  key: null,
  direction: null,
  ms: null,
};

describe("NavigateReply", () => {
  it("turns the strict wire form (unused fields null) into a NavAction", () => {
    const reply = {
      thought: "Apply the code",
      phase: "trigger",
      action: { ...nulls, op: "click", ref: "e21" },
      status: "trigger_done",
      watch: [{ label: "order total", ref: "e14" }],
      reason: null,
    };
    expect(NavigateReply.parse(reply)).toEqual({
      thought: "Apply the code",
      phase: "trigger",
      action: { op: "click", ref: "e21" },
      status: "trigger_done",
      watch: [{ label: "order total", ref: "e14" }],
    });
  });

  it("keeps each op's own fields", () => {
    const op = (fields: Record<string, unknown>) =>
      NavigateReply.parse({
        thought: "",
        phase: "setup",
        action: { ...nulls, ...fields },
        status: "continue",
        watch: null,
        reason: null,
      }).action;
    expect(op({ op: "fill", ref: "e7", value: "SAVE10" })).toEqual({
      op: "fill",
      ref: "e7",
      value: "SAVE10",
    });
    expect(op({ op: "goto", path: "/cart", ref: "e1" })).toEqual({ op: "goto", path: "/cart" });
    expect(op({ op: "scroll" })).toEqual({ op: "scroll", direction: "down" });
    expect(op({ op: "wait", ms: 1000 })).toEqual({ op: "wait", ms: 1000 });
    expect(op({ op: "back" })).toEqual({ op: "back" });
  });

  it("takes a give_up with a null action", () => {
    expect(
      NavigateReply.parse({
        thought: "No code field",
        phase: "trigger",
        action: null,
        status: "give_up",
        watch: null,
        reason: "trigger_not_found",
      }),
    ).toEqual({
      thought: "No code field",
      phase: "trigger",
      status: "give_up",
      reason: "trigger_not_found",
    });
  });

  it("enforces NavAction's rules", () => {
    const bad = NavigateReply.safeParse({
      thought: "",
      phase: "trigger",
      action: { ...nulls, op: "click", ref: "e1" },
      status: "trigger_done",
      watch: [],
      reason: null,
    });
    expect(bad.success).toBe(false);
    expect(
      NavigateReply.safeParse({
        thought: "",
        phase: "setup",
        action: { ...nulls, op: "goto", path: "https://evil.example" },
        status: "continue",
      }).success,
    ).toBe(false);
  });

  it("matches the JSON schema's required fields", () => {
    expect(NAVIGATE_JSON_SCHEMA.required).toEqual([
      "thought",
      "phase",
      "action",
      "status",
      "watch",
      "reason",
    ]);
  });
});

describe("renderNavigate", () => {
  const input = {
    criterion: c2,
    outline:
      '<untrusted source="page_outline" url="/cart">\n- button "Apply" [ref=e21]\n</untrusted>',
    history: [
      { n: 1, phase: "setup", action: { op: "goto", path: "/cart" } as const, result: "ok" },
    ],
    lastResult: "ok",
    step: 2,
    maxSteps: 25,
    data: ["SAVE10"],
  };

  it("never shows the model what should happen (§20.6)", () => {
    const text = renderNavigate(input);
    expect(text).not.toContain(c2.expected);
    expect(text).not.toContain("$45.00");
    expect(text).not.toContain(c2.text);
  });

  it("carries the trigger, setup, watch, data, history and outline", () => {
    const text = renderNavigate(input);
    expect(text).toContain(`Trigger: ${c2.trigger}`);
    expect(text).toContain(`- ${c2.setup[0]}`);
    expect(text).toContain("Watch: order total");
    expect(text).toContain("Test data you may use: SAVE10");
    expect(text).toContain("1. [setup] goto /cart → ok");
    expect(text).toContain("Step 2 of at most 25.");
    expect(text).toContain('- button "Apply" [ref=e21]');
  });
});
