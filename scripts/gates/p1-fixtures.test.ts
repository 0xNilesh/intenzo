import { existsSync, readdirSync, readFileSync } from "node:fs";

import { Criterion, SavedPath } from "@intenzo/core";
import { describe, expect, it } from "vitest";

import { REPO_ROOT } from "../probe/lib/env.ts";
import { GroundTruth, SIDES } from "./lib/p1.ts";

// The P1 gate records hand-written paths for C1–C4 (ROADMAP P1 gate). Each one must parse with
// the core schemas and agree with its criterion and with ground-truth.json before a recording can
// be scored. C2's pair comes with T1.6, so it's checked once it exists.

/** core's label for the live-region reading (browser/readings.ts), which every lane takes. */
const LIVE_REGIONS = "live regions";

const FIXTURES = `${REPO_ROOT}fixtures/`;
const GATE_CRITERIA = ["C1", "C2", "C3", "C4"];
const OWNED_HERE = ["C1", "C3", "C4"];

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));
const ids = (dir: string) =>
  readdirSync(`${FIXTURES}${dir}`)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length))
    .sort();

describe("the P1 gate's criteria and paths", () => {
  it("has C1, C3 and C4, with C2 once T1.6 adds it", () => {
    for (const dir of ["criteria", "paths"]) {
      expect(ids(dir)).toEqual(expect.arrayContaining(OWNED_HERE));
      expect(GATE_CRITERIA).toEqual(expect.arrayContaining(ids(dir)));
    }
  });

  for (const id of GATE_CRITERIA) {
    const criterionFile = `${FIXTURES}criteria/${id}.json`;
    const pathFile = `${FIXTURES}paths/${id}.json`;
    if (!existsSync(criterionFile) || !existsSync(pathFile)) continue;

    describe(id, () => {
      const criterion = Criterion.parse(readJson(criterionFile));
      const path = SavedPath.parse(readJson(pathFile));

      it("is named after its id", () => {
        expect(criterion.id).toBe(id);
        expect(path.criterionId).toBe(id);
      });

      it("watches only what its criterion names", () => {
        for (const w of path.watch) expect(criterion.watch).toContain(w.label);
      });

      it("starts on the cart and replays anywhere", () => {
        expect(path.setup[0]).toEqual({ op: "goto", path: "/cart" });
        expect(path.portable).toBe(true);
      });
    });
  }

  describe("ground-truth.json", () => {
    const truth = GroundTruth.parse(readJson(`${FIXTURES}ground-truth.json`));

    it("covers C1–C4 on both sides, at the protocol's POST offsets", () => {
      expect(Object.keys(truth.criteria).sort()).toEqual(GATE_CRITERIA);
      expect(truth.offsetsMs).toEqual([0, 1000, 3000]);
    });

    it("expects main, which has no discount codes, to end trigger_absent after PRE", () => {
      for (const sides of Object.values(truth.criteria)) {
        expect(sides.base.status).toBe("trigger_absent");
        expect(sides.base.readings.every((r) => r.phase === "pre")).toBe(true);
      }
    });

    it("expects the almost-right PR's stale total: $50.00 until the reload shows $45.00", () => {
      const total = truth.criteria.C2!.pr.readings.filter((r) => r.label === "order total");
      expect(total.map((r) => [r.phase, r.atMs ?? null, r.value])).toEqual([
        ["pre", null, "$50.00"],
        ["post", [0, 1000, 3000], "$50.00"],
        ["after_reload", null, "$45.00"],
      ]);
    });

    for (const [id, sides] of Object.entries(truth.criteria)) {
      const pathFile = `${FIXTURES}paths/${id}.json`;
      if (!existsSync(pathFile)) continue;
      const path = SavedPath.parse(readJson(pathFile));
      const watched = [...path.watch.map((w) => w.label), LIVE_REGIONS].sort();

      for (const side of SIDES) {
        it(`reads exactly ${id}'s watch targets and the live regions on ${side}`, () => {
          expect([...new Set(sides[side].readings.map((r) => r.label))].sort()).toEqual(watched);
        });
      }
    }
  });

  it("rejects a path without a region, so a broken fixture can't pass", () => {
    const path = readJson(`${FIXTURES}paths/C1.json`) as { watch: { scope: string }[] };
    const elementsOnly = { ...path, watch: path.watch.filter((w) => w.scope === "element") };
    expect(SavedPath.safeParse(elementsOnly).success).toBe(false);
  });
});
