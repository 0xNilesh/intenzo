import { describe, expect, it } from "vitest";

import { describeString, shapeOf } from "./shape.ts";

describe("shapeOf", () => {
  it("keeps scalars and short strings", () => {
    expect(shapeOf({ model: "muse-spark-1.3", n: 1, stream: false, x: null })).toEqual({
      model: "muse-spark-1.3",
      n: 1,
      stream: false,
      x: null,
    });
  });

  it("collapses base64 data URLs to their media type and size", () => {
    const url = `data:video/mp4;base64,${"A".repeat(4000)}`;
    expect(shapeOf({ video_url: { url } })).toEqual({
      video_url: { url: "<data-url video/mp4 · 4000 chars>" },
    });
  });

  it("keeps the first array item and counts the rest", () => {
    expect(shapeOf([{ type: "text" }, { type: "image_url" }, { type: "video_url" }])).toEqual([
      { type: "text" },
      "…2 more",
    ]);
  });

  it("redacts anything under a secret-looking key, at any depth", () => {
    expect(
      shapeOf({
        authorization: { accessToken: "Bearer sk-live" },
        nested: { api_key: "k", Authorization: "Bearer x", password: "p", keep: "ok" },
      }),
    ).toEqual({
      authorization: "<redacted>",
      nested: {
        api_key: "<redacted>",
        Authorization: "<redacted>",
        password: "<redacted>",
        keep: "ok",
      },
    });
  });

  it("stops at a fixed depth", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 12; i++) deep = { d: deep };
    expect(JSON.stringify(shapeOf(deep))).toContain("<nested>");
  });
});

describe("describeString", () => {
  it("truncates long strings and keeps their length", () => {
    const out = describeString("x".repeat(500));
    expect(out.startsWith("x".repeat(120))).toBe(true);
    expect(out.endsWith("<500 chars>")).toBe(true);
  });
});
