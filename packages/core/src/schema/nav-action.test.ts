import { describe, expect, it } from "vitest";

import { NavAction, OutlineRef } from "./navigation.ts";
import { issues } from "./test-helpers.ts";

const click = { op: "click", ref: "e12" } as const;
const base = { thought: "Apply the code", phase: "trigger" } as const;

describe("OutlineRef", () => {
  it.each(["e1", "e12", "f1e3"])("accepts %s", (ref) => {
    expect(issues(OutlineRef, ref)).toEqual([]);
  });
  it.each(["12", "button", "#apply", "e", "aria-ref=e2"])("rejects %s", (ref) => {
    expect(issues(OutlineRef, ref)).not.toEqual([]);
  });
});

describe("NavAction", () => {
  it("accepts a continue step and a finished trigger with watch elements", () => {
    expect(issues(NavAction, { ...base, action: click, status: "continue" })).toEqual([]);
    expect(
      issues(NavAction, {
        ...base,
        action: click,
        status: "trigger_done",
        watch: [{ label: "order total", ref: "e20" }],
      }),
    ).toEqual([]);
  });

  it("accepts give_up with a reason and no action", () => {
    expect(issues(NavAction, { ...base, status: "give_up", reason: "trigger_not_found" })).toEqual(
      [],
    );
  });

  it.each([
    [{ ...base, status: "continue" }, "action: continue needs an action"],
    [
      { ...base, action: click, status: "trigger_done" },
      "watch: trigger_done needs at least one watch element",
    ],
    [{ ...base, status: "give_up" }, "reason: give_up needs a reason"],
    [
      { ...base, action: click, status: "give_up", reason: "blocked" },
      "action: give_up takes no action",
    ],
    [
      { ...base, action: click, status: "continue", reason: "blocked" },
      "reason: only give_up has a reason",
    ],
    [
      { ...base, action: click, status: "continue", watch: [{ label: "x", ref: "e1" }] },
      "watch: only trigger_done names watch elements",
    ],
    [
      {
        ...base,
        action: { op: "expand", ref: "e2" },
        status: "trigger_done",
        watch: [{ label: "x", ref: "e1" }],
      },
      "action: expand can't be the trigger",
    ],
  ])("rejects %j", (action, message) => {
    expect(issues(NavAction, action)).toContain(message);
  });

  it("keeps goto on the app's own origin and caps waits", () => {
    const goto = (path: string) => ({ ...base, action: { op: "goto", path }, status: "continue" });
    expect(issues(NavAction, goto("/cart"))).toEqual([]);
    expect(issues(NavAction, goto("https://evil.example/"))).not.toEqual([]);
    expect(issues(NavAction, goto("//evil.example/"))).not.toEqual([]);
    expect(
      issues(NavAction, { ...base, action: { op: "wait", ms: 5000 }, status: "continue" }),
    ).not.toEqual([]);
  });
});
