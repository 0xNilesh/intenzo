import { describe, expect, it } from "vitest";

import { anchorsIn, brokenLinks, githubSlug, linksIn } from "./links.ts";

describe("linksIn", () => {
  it("finds links and images, with titles and nested brackets, and reference definitions", () => {
    const md = [
      "See [the design](docs/ARCHITECTURE.md#19-verify-workflow) and ![chart](bench/results/cost.png).",
      'A [link with [brackets]](README.md "a title"), and <https://example.com>.',
      "[ref]: CONTRIBUTING.md",
    ].join("\n");
    expect(linksIn(md)).toEqual([
      { target: "docs/ARCHITECTURE.md#19-verify-workflow", line: 1 },
      { target: "bench/results/cost.png", line: 1 },
      { target: "README.md", line: 2 },
      { target: "CONTRIBUTING.md", line: 3 },
    ]);
  });

  it("skips code: fenced blocks and inline spans", () => {
    const md = [
      "```md",
      "[not](a-link.md)",
      "```",
      "Use `[x](y.md)` here, then [real](z.md).",
    ].join("\n");
    expect(linksIn(md)).toEqual([{ target: "z.md", line: 4 }]);
  });
});

describe("githubSlug (GitHub's heading anchors)", () => {
  it.each([
    ["19. Verify workflow", "19-verify-workflow"],
    ["T6.3 Judge many (offline)", "t63-judge-many-offline"],
    // The P7 gate issue links ROADMAP.md#-phase-7-gate-pnpm-gatep7.
    ["✅ Phase 7 gate: `pnpm gate:p7`", "-phase-7-gate-pnpm-gatep7"],
    ["2026-11-01 · IntentBench judged (T6.3, #50)", "2026-11-01--intentbench-judged-t63-50"],
    ["See [the docs](docs/x.md) now", "see-the-docs-now"],
    ["snake_case and Ünïcode", "snake_case-and-ünïcode"],
  ])("%j → %j", (heading, slug) => {
    expect(githubSlug(heading)).toBe(slug);
  });

  it("numbers repeated headings, and ignores headings in code", () => {
    const md = ["# Notes", "## Notes", "```", "# Notes", "```", "### Notes"].join("\n");
    expect([...anchorsIn(md)]).toEqual(["notes", "notes-1", "notes-2"]);
  });
});

describe("brokenLinks", () => {
  const files = new Map([
    [
      "README.md",
      [
        "# Intenzo",
        "[design](docs/ARCHITECTURE.md#19-verify-workflow) · [bad anchor](docs/ARCHITECTURE.md#20-nope)",
        "[gone](docs/GONE.md) · [folder](bench/intentbench) · [here](#intenzo) · [site](https://x.dev)",
        "[up and out](../elsewhere.md) · [rooted](/docs/ARCHITECTURE.md) · [code line](apps/a.ts#L10)",
        "[a template's slot]({report}#C1)",
      ].join("\n"),
    ],
    ["docs/ARCHITECTURE.md", "## 19. Verify workflow\n[back](../README.md#intenzo)"],
  ]);
  const real = new Set(["README.md", "docs/ARCHITECTURE.md", "bench/intentbench", "apps/a.ts"]);

  it("reports missing files and headings, and leaves external links alone", () => {
    expect(brokenLinks(files, (p) => real.has(p))).toEqual([
      "README.md:2: docs/ARCHITECTURE.md#20-nope: no heading #20-nope in docs/ARCHITECTURE.md",
      "README.md:3: docs/GONE.md: no such file",
      "README.md:4: ../elsewhere.md: no such file",
    ]);
  });
});
