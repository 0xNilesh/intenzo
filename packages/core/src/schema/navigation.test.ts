import { describe, expect, it } from "vitest";

import { ArtifactRef } from "./artifact.ts";
import { LoggedStep, SavedPath, Step, Target } from "./navigation.ts";
import { issues } from "./test-helpers.ts";

const apply = { by: "role", role: "button", name: "Apply" } as const;
const cartForm = {
  label: "cart form",
  scope: "region",
  target: { by: "testId", id: "cart" },
} as const;
const total = {
  label: "order total",
  scope: "element",
  target: { by: "testId", id: "order-total" },
} as const;

const path = {
  criterionId: "C2",
  setup: [
    { op: "goto", path: "/products" },
    { op: "click", target: { by: "role", role: "button", name: "Add to cart", nth: 0 } },
    { op: "goto", path: "/cart" },
    { op: "fill", target: { by: "label", text: "Discount code" }, value: "SAVE10" },
  ],
  trigger: [{ op: "click", target: apply }],
  watch: [total, cartForm],
  portable: true,
};

describe("Target", () => {
  it("has no default nth: an omitted nth stays absent", () => {
    const parsed = Target.parse(apply);
    expect(parsed).toEqual(apply);
    expect("nth" in parsed).toBe(false);
  });

  it("rejects a negative nth", () => {
    expect(issues(Target, { ...apply, nth: -1 })[0]).toMatch(/^nth: /);
  });

  it("rejects an unknown way of finding an element", () => {
    expect(issues(Target, { by: "xpath", expr: "//button" })[0]).toMatch(/^by: /);
  });
});

describe("Step", () => {
  it("caps waits at 3000 ms, pointing at ms", () => {
    expect(issues(Step, { op: "wait", ms: 5000 })[0]).toMatch(/^ms: /);
    expect(Step.parse({ op: "wait", ms: 3000 })).toEqual({ op: "wait", ms: 3000 });
  });

  it.each([["https://evil.example/cart"], ["//evil.example/cart"], ["cart"]])(
    "only navigates within the app: rejects %j",
    (p) => {
      expect(issues(Step, { op: "goto", path: p })).toEqual([
        "path: must be a path on the app's own origin",
      ]);
    },
  );

  it("rejects an op the navigator doesn't have", () => {
    expect(issues(Step, { op: "reload" })[0]).toMatch(/^op: /);
    expect(issues(Step, { op: "eval", code: "1" })[0]).toMatch(/^op: /);
  });
});

describe("LoggedStep", () => {
  it("adds the recorder's reload probe to the navigator steps", () => {
    expect(LoggedStep.parse({ op: "reload" })).toEqual({ op: "reload" });
    expect(LoggedStep.parse({ op: "back" })).toEqual({ op: "back" });
  });
});

describe("SavedPath", () => {
  it("parses a portable path with a region watch", () => {
    expect(SavedPath.parse(path).trigger).toHaveLength(1);
  });

  it("requires at least one region watch target", () => {
    expect(issues(SavedPath, { ...path, watch: [total] })).toEqual([
      "watch: must include at least one region",
    ]);
  });

  it("can't be portable with a point target", () => {
    const point = { by: "point", x: 680, y: 425, viewport: [1280, 720] };
    const withPoint = { ...path, trigger: [{ op: "click", target: point }] };
    expect(issues(SavedPath, withPoint)).toEqual([
      "portable: a path with a point target can't be portable",
    ]);
    expect(SavedPath.parse({ ...withPoint, portable: false }).portable).toBe(false);
  });

  it("requires a trigger step", () => {
    expect(issues(SavedPath, { ...path, trigger: [] })[0]).toMatch(/^trigger: /);
  });
});

describe("ArtifactRef", () => {
  it("parses a recording reference", () => {
    const ref = {
      store: "private",
      path: "runs/r1/C2/pr/take-1/video.mp4",
      contentType: "video/mp4",
    };
    expect(ArtifactRef.parse(ref)).toEqual(ref);
  });

  it.each([["/runs/x.mp4"], ["runs/../secrets.json"], [""]])("rejects the path %j", (p) => {
    const result = issues(ArtifactRef, { store: "public", path: p, contentType: "image/gif" });
    expect(result[0]).toMatch(/^path: /);
  });
});
