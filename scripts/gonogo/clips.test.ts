import { describe, expect, it } from "vitest";

import { CLIPS } from "./clips.ts";
import { Criterion, Step, WatchTarget } from "./lib/schema.ts";

describe("go/no-go clips", () => {
  it("are 4 correct, 4 almost-right and 2 ambiguous, with unique ids", () => {
    const count = (label: string) => CLIPS.filter((c) => c.label === label).length;
    expect([count("pass"), count("fail"), count("ambiguous")]).toEqual([4, 4, 2]);
    expect(new Set(CLIPS.map((c) => c.id)).size).toBe(CLIPS.length);
  });

  it("cover the four almost-right defects named in the roadmap", () => {
    const failing = CLIPS.filter((c) => c.label === "fail").map((c) => c.variant);
    expect(failing.sort()).toEqual([
      "missing-error",
      "off-by-cent",
      "stale-total",
      "wrong-percent",
    ]);
  });

  it.each(CLIPS)("$id: criterion, steps and watch targets are well formed", (clip) => {
    expect(() => Criterion.parse(clip.criterion)).not.toThrow();
    for (const step of [...clip.setup, ...clip.trigger])
      expect(() => Step.parse(step)).not.toThrow();
    for (const target of clip.watch) expect(() => WatchTarget.parse(target)).not.toThrow();
    // Every watched label in the criterion has exactly one target, in the same order.
    expect(clip.watch.map((w) => w.label)).toEqual(clip.criterion.watch);
    expect(clip.trigger.at(-1)).toEqual({ op: "click", target: { by: "testId", id: "apply" } });
  });
});
