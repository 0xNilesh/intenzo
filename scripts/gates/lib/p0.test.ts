import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { REPO_ROOT } from "../../probe/lib/env.ts";
import { missingDecisions, missingFromGolden } from "./p0.ts";

describe("the P0 gate's document checks", () => {
  it("finds every P0 decision in the real DECISIONS.md", () => {
    expect(missingDecisions(readFileSync(`${REPO_ROOT}docs/DECISIONS.md`, "utf8"))).toEqual([]);
  });

  it("names what's missing", () => {
    expect(missingDecisions("## 2026-10-30 · Judge go/no-go: GO (T0.3, #4)")).toHaveLength(6);
    expect(missingDecisions("")[0]).toBe("the go/no-go result (T0.3)");
  });

  it("finds C1–C4, C2's readings and the ⚠️ line in the real golden comment", () => {
    expect(missingFromGolden(readFileSync(`${REPO_ROOT}demo/expected-comment.md`, "utf8"))).toEqual(
      [],
    );
  });

  it("notices a golden comment that lost a criterion or the readings", () => {
    const golden = readFileSync(`${REPO_ROOT}demo/expected-comment.md`, "utf8");
    expect(missingFromGolden(golden.replace("| ✅ | C4 ", "| ❌ | C4 "))).toEqual(["C4"]);
    expect(missingFromGolden(golden.replace("after reload $45.00", "after reload $50.00"))).toEqual(
      ["C2's readings line"],
    );
  });
});
