import { describe, expect, it } from "vitest";

import type { Recording } from "@intenzo/core/browser";

import { formatRecording, localRunDir, parseRecordArgs, UsageError } from "./record.ts";

describe("parseRecordArgs", () => {
  it("needs --path and --pr, and defaults the rest", () => {
    expect(parseRecordArgs(["--path", "p.json", "--pr", "http://localhost:3001"])).toEqual({
      path: "p.json",
      pr: "http://localhost:3001",
      config: "packages/core/fixtures/config/demo-shop.intenzo.yml",
      hookSecretEnv: "DEMO_SHOP_HOOK_SECRET",
      bypassEnv: "DEMO_SHOP_BYPASS_SECRET",
    });
    expect(() => parseRecordArgs(["--pr", "http://localhost:3001"])).toThrow(UsageError);
    expect(() => parseRecordArgs(["--path", "p.json"])).toThrow("--pr is required");
  });

  it("rejects unknown flags and bad URLs", () => {
    const base = ["--path", "p.json", "--pr", "http://localhost:3001"];
    expect(() => parseRecordArgs([...base, "--verbose"])).toThrow(UsageError);
    expect(() => parseRecordArgs([...base, "--base", "localhost"])).toThrow("--base must be a URL");
  });
});

describe("localRunDir", () => {
  it("names a local run by its UTC start time", () => {
    expect(localRunDir(new Date("2026-10-30T23:15:00.123Z"))).toBe(
      "out/runs/local-20261030-231500",
    );
  });
});

describe("formatRecording", () => {
  const tt = 1_000_000;
  const recording: Recording = {
    lane: {
      criterionId: "C2",
      side: "pr",
      status: "completed",
      laneStartMs: tt - 2000,
      tTriggerMs: tt,
      stepLog: [],
      readings: [
        {
          i: 0,
          label: "order total",
          kind: "text",
          phase: "pre",
          tMs: tt - 500,
          value: "$50.00",
          bbox: null,
        },
        {
          i: 1,
          label: "order summary",
          kind: "region_diff",
          phase: "post",
          tMs: tt + 1004,
          value: "- a\n+ b",
          bbox: null,
        },
        {
          i: 2,
          label: "live regions",
          kind: "absent",
          phase: "after_reload",
          tMs: tt + 4100,
          value: null,
          bbox: null,
        },
      ],
      consoleErrorCount: 0,
      failedRequestCount: 1,
      isolation: "ephemeral_user",
    },
    rawVideo: "/tmp/raw.webm",
    alignment: { status: "ok", offsetMs: 850 - (tt - 1500), method: "marker" },
    markerShownAt: tt - 1500,
    shotPath: null,
    annotatedShotPath: null,
    boxTrack: [],
  };

  it("prints the status, the alignment and one line per reading, timed from Tt", () => {
    const text = formatRecording("pr", "http://localhost:3001", recording);
    expect(text).toContain("PR http://localhost:3001 · completed · isolation ephemeral_user");
    expect(text).toContain("alignment ok (marker): the marker is at 0.85 s in raw.webm");
    expect(text).toMatch(/order total\s+pre\s+−0\.50 s\s+text\s+\$50\.00/);
    expect(text).toMatch(/order summary\s+post\s+\+1\.00 s\s+region_diff\s+- a ⏎ \+ b/);
    expect(text).toMatch(/live regions\s+after_reload\s+\+4\.10 s\s+absent\s+—/);
    expect(text).toContain("console errors 0 · failed requests 1");
  });

  it("names the failed step and times readings from the lane start when there's no Tt", () => {
    const absent: Recording = {
      ...recording,
      lane: {
        ...recording.lane,
        status: "trigger_absent",
        tTriggerMs: null,
        failedStepIndex: 1,
        stepLog: [
          { tMs: tt - 1900, step: { op: "goto", path: "/cart" }, ok: true, trigger: false },
          {
            tMs: tt,
            step: { op: "fill", target: { by: "label", text: "Discount code" }, value: "SAVE10" },
            ok: false,
            trigger: true,
            error: 'no field labelled "Discount code" on the page',
          },
        ],
        readings: [recording.lane.readings[0]!],
      },
    };
    const text = formatRecording("base", "http://localhost:3000", absent);
    expect(text).toContain("BASE http://localhost:3000 · trigger_absent");
    expect(text).toContain('step 1 (fill) failed: no field labelled "Discount code" on the page');
    expect(text).toContain("t from lane start (no Tt)");
    expect(text).toMatch(/order total\s+pre\s+\+1\.50 s/);
  });
});
