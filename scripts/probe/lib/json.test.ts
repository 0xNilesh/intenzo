import { describe, expect, it } from "vitest";

import { allKeys, allStrings, asArray, asString, dig } from "./json.ts";

describe("dig", () => {
  const body = { choices: [{ message: { content: "OK" } }] };

  it("follows object keys and array indexes", () => {
    expect(dig(body, "choices", 0, "message", "content")).toBe("OK");
  });

  it("returns undefined for missing paths instead of throwing", () => {
    expect(dig(body, "choices", 3, "message")).toBeUndefined();
    expect(dig("not an object", "x")).toBeUndefined();
    expect(dig(null, "x")).toBeUndefined();
  });
});

describe("asString / asArray", () => {
  it("narrow unknown values with safe fallbacks", () => {
    expect(asString(42)).toBe("");
    expect(asString("x")).toBe("x");
    expect(asArray({ length: 1 })).toEqual([]);
    expect(asArray([1])).toEqual([1]);
  });
});

describe("allStrings", () => {
  it("collects strings from nested objects and arrays", () => {
    expect(allStrings({ a: "x", b: [{ c: "y" }, 3, null], d: { e: "z" } })).toEqual([
      "x",
      "y",
      "z",
    ]);
  });
});

describe("allKeys", () => {
  it("collects every key once, in first-seen order", () => {
    expect(
      allKeys({
        text: "",
        words: [
          { start: 0, end: 1 },
          { start: 1, end: 2 },
        ],
      }),
    ).toEqual(["text", "words", "start", "end"]);
  });
});
