import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { scriptedPort } from "../models/scripted.ts";
import { Criterion, type ContextBundle } from "../schema/index.ts";
import { mapCoverage } from "./coverage.ts";
import { routeCandidates, routeOf } from "./routes.ts";

const FIXTURES = new URL("../../../../fixtures/criteria/", import.meta.url);
const criteria = ["C1", "C2", "C3", "C4"].map((id) =>
  Criterion.parse(JSON.parse(readFileSync(new URL(`${id}.json`, FIXTURES), "utf8"))),
);

describe("routeOf (Next.js conventions)", () => {
  it.each([
    ["app/(shop)/cart/page.tsx", "/cart"],
    ["app/page.tsx", "/"],
    ["src/app/products/[id]/page.tsx", "/products/[id]"],
    ["app/cart/CartSummary.tsx", "/cart"],
    ["app/(shop)/cart/layout.tsx", "/cart"],
    ["app/layout.tsx", "/"],
    ["app/actions.ts", null],
    ["app/globals.css", null],
    ["app/api/cart/route.ts", null],
    ["app/cart/route.ts", null],
    ["app/_lib/money.ts", null],
    ["pages/cart.tsx", "/cart"],
    ["pages/index.tsx", "/"],
    ["src/pages/products/[id].tsx", "/products/[id]"],
    ["pages/products/index.jsx", "/products"],
    ["pages/api/apply.ts", null],
    ["pages/_app.tsx", null],
    ["components/CartView.tsx", null],
    ["lib/cart.ts", null],
  ])("%s → %s", (file, route) => {
    expect(routeOf(file)).toBe(route);
  });

  it("lists each route once, static ones first", () => {
    expect(
      routeCandidates(["app/products/[id]/page.tsx", "app/cart/page.tsx", "app/cart/Total.tsx", "lib/cart.ts"]),
    ).toEqual(["/cart", "/products/[id]"]);
  });
});

const file = (path: string, patch = "+ changed"): ContextBundle["diff"]["files"][number] => ({
  path,
  status: "modified",
  additions: 1,
  deletions: 0,
  patch,
});
/** A PR that implements the discount line, the total and the chart, but not the expired code. */
const NO_C3 = {
  files: [file("lib/cart.ts"), file("components/CartView.tsx"), file("components/SavingsChart.tsx"), file("app/cart/page.tsx")],
};

describe("mapCoverage (§18)", () => {
  it("keeps the model's reading of each criterion, with the diff's routes", async () => {
    const port = scriptedPort([
      {
        items: [
          { criterionId: "C1", files: ["components/CartView.tsx"], status: "covered" },
          { criterionId: "C2", files: ["lib/cart.ts", "components/CartView.tsx"], status: "covered" },
          { criterionId: "C3", files: [], status: "uncovered" },
          { criterionId: "C4", files: ["components/SavingsChart.tsx"], status: "covered" },
        ],
      },
    ]);
    const result = await mapCoverage(port, criteria, NO_C3);
    expect(result).toMatchObject({ ok: true, problems: [], calls: 1 });
    expect(result.coverage.items.map((i) => `${i.criterionId} ${i.status}`)).toEqual([
      "C1 covered",
      "C2 covered",
      "C3 uncovered",
      "C4 covered",
    ]);
    expect(result.coverage.routes).toEqual(["/cart"]);
    expect(port.requests[0]).toMatchObject({ stage: "coverage", model: "muse-spark-1.3" });
    expect(port.requests[0]!.promptVersion).toBe("coverage.v1");
    const prompt = port.requests[0]!.messages[1]!.content as string;
    expect(prompt).toContain('<untrusted source="diff">\n--- lib/cart.ts (modified, +1 −0)');
  });

  it("holds the reply to the diff", async () => {
    const port = scriptedPort([
      {
        items: [
          { criterionId: "C1", files: ["lib/elsewhere.ts"], status: "covered" },
          { criterionId: "C2", files: ["lib/cart.ts", "lib/cart.ts"], status: "covered" },
          { criterionId: "C3", files: [], status: "uncovered" },
        ],
      },
    ]);
    const result = await mapCoverage(port, criteria, NO_C3);
    expect(result.coverage.items).toEqual([
      { criterionId: "C1", files: [], status: "unclear" },
      { criterionId: "C2", files: ["lib/cart.ts"], status: "covered" },
      { criterionId: "C3", files: [], status: "uncovered" },
      { criterionId: "C4", files: [], status: "unclear" },
    ]);
    expect(result.problems).toEqual([
      "C1: not in the diff: lib/elsewhere.ts",
      "C4: no coverage item in the reply",
    ]);
  });

  it("calls no model for an empty diff: nothing is covered", async () => {
    const port = scriptedPort([]);
    const result = await mapCoverage(port, criteria, { files: [] });
    expect(result.calls).toBe(0);
    expect(new Set(result.coverage.items.map((i) => i.status))).toEqual(new Set(["uncovered"]));
  });

  it("calls it unclear, not uncovered, when the call fails", async () => {
    const result = await mapCoverage(scriptedPort([{ items: "nope" }]), criteria, NO_C3);
    expect(result.ok).toBe(false);
    expect(new Set(result.coverage.items.map((i) => i.status))).toEqual(new Set(["unclear"]));
  });

  it("shows a long diff only up to the cap, and says how much is left out", async () => {
    const big = { files: Array.from({ length: 40 }, (_, i) => file(`lib/f${i}.ts`, "+".repeat(3000))) };
    const port = scriptedPort([{ items: [] }]);
    await mapCoverage(port, criteria, big);
    const prompt = port.requests[0]!.messages[1]!.content as string;
    expect(prompt.length).toBeLessThan(64_000);
    expect(prompt).toMatch(/\(\d+ more changed file\(s\) not shown: the diff is too long\)/);
  });
});
