import { describe, expect, it } from "vitest";

import type { HttpResult } from "./http.ts";
import type { Media } from "./media.ts";
import {
  capability,
  failed,
  missingKey,
  quote,
  sampled,
  succeeded,
  type ProbeContext,
} from "./probe.ts";
import type { ProbeResult } from "./results.ts";

const res = (over: Partial<HttpResult> = {}): HttpResult => ({
  status: 200,
  ok: true,
  ms: 100,
  headers: new Headers({ "x-request-id": "r1" }),
  body: { ok: true },
  text: '{"ok":true}',
  ...over,
});

function context(): { ctx: ProbeContext; recorded: Omit<ProbeResult, "at">[] } {
  const recorded: Omit<ProbeResult, "at">[] = [];
  return { recorded, ctx: { samples: 3, media: {} as Media, record: (r) => recorded.push(r) } };
}

describe("capability", () => {
  it("records the outcome under the model and capability", async () => {
    const { ctx, recorded } = context();
    await capability(ctx, "wonder", "text", async () => ({
      status: "ok",
      latencyMs: null,
      correct: true,
    }));
    expect(recorded).toEqual([
      { model: "wonder", capability: "text", status: "ok", latencyMs: null, correct: true },
    ]);
  });

  it("turns a thrown error into an error result instead of aborting the run", async () => {
    const { ctx, recorded } = context();
    await capability(ctx, "sam-3.1", "video_box", async () => {
      throw new Error("ffmpeg missing");
    });
    expect(recorded[0]).toMatchObject({ status: "error", error: "ffmpeg missing" });
  });
});

describe("only", () => {
  it("skips capabilities that aren't listed, without running them", async () => {
    const { ctx, recorded } = context();
    let ran = false;
    await capability({ ...ctx, only: ["text"] }, "wonder", "computer_use", async () => {
      ran = true;
      return { status: "ok", latencyMs: null, correct: null };
    });
    expect(ran).toBe(false);
    expect(recorded).toEqual([]);
  });

  it("also limits missing-key results to the listed capabilities", () => {
    const { ctx, recorded } = context();
    missingKey({ ...ctx, only: ["video"] }, "spark-open", ["text", "video"], "BASETEN_API_KEY");
    expect(recorded.map((r) => r.capability)).toEqual(["video"]);
  });
});

describe("missingKey", () => {
  it("records every capability as error, naming the variable", () => {
    const { ctx, recorded } = context();
    missingKey(ctx, "spark-open", ["text", "video"], "BASETEN_API_KEY");
    expect(recorded.map((r) => `${r.capability}:${r.status}`)).toEqual([
      "text:error",
      "video:error",
    ]);
    expect(recorded[0]?.error).toContain("BASETEN_API_KEY is not set");
  });
});

describe("sampled", () => {
  it("collects one latency sample per successful call", async () => {
    let calls = 0;
    const run = await sampled(3, async () => res({ ms: 100 + calls++ }));
    expect("failure" in run).toBe(false);
    if (!("failure" in run)) expect(run.samples).toEqual([100, 101, 102]);
  });

  it("stops at the first failure", async () => {
    let calls = 0;
    const run = await sampled(5, async () =>
      ++calls === 2 ? res({ ok: false, status: 500 }) : res(),
    );
    expect(calls).toBe(2);
    expect("failure" in run && run.failure.status).toBe(500);
  });

  it("always makes at least one call", async () => {
    let calls = 0;
    await sampled(0, async () => {
      calls++;
      return res();
    });
    expect(calls).toBe(1);
  });
});

describe("failed", () => {
  it("classifies a modality rejection as unsupported", () => {
    const out = failed(
      res({ ok: false, status: 400, text: "video input is not supported", body: {} }),
    );
    expect(out.status).toBe("unsupported");
    expect(out.error).toBe("HTTP 400: video input is not supported");
  });

  it("classifies other failures as error, without latency when nothing answered", () => {
    expect(failed(res({ ok: false, status: 401, text: "bad key" })).status).toBe("error");
    expect(failed(res({ ok: false, status: 0, text: "timeout" })).latencyMs).toBeNull();
  });
});

describe("succeeded", () => {
  it("records latency, shapes and rate-limit headers", () => {
    const out = succeeded({ samples: [120, 80, 100], last: res() }, { model: "m" }, true, "note");
    expect(out).toMatchObject({
      status: "ok",
      latencyMs: { p50: 100, samples: [120, 80, 100] },
      correct: true,
      request: { model: "m" },
      limits: { "x-request-id": "r1" },
      notes: "note",
    });
  });
});

describe("quote", () => {
  it("flattens whitespace and shortens long answers", () => {
    expect(quote("start=50,\n end=45")).toBe('"start=50, end=45"');
    expect(quote("x".repeat(300), 10)).toBe(`"${"x".repeat(10)}…"`);
  });
});
