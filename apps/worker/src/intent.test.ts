import { describe, expect, it } from "vitest";

import { parseIntentArgs, readTicketFile } from "./intent.ts";
import { UsageError } from "./record.ts";

describe("intenzo intent", () => {
  it("reads a markdown ticket's title and body", () => {
    expect(readTicketFile("# Discount codes\r\n\r\nApply SAVE10.\n- [ ] one\n", "#42")).toEqual({
      ref: "#42",
      title: "Discount codes",
      body: "Apply SAVE10.\n- [ ] one",
      comments: [],
    });
    expect(readTicketFile("No heading here", "#1")).toMatchObject({
      title: "",
      body: "No heading here",
    });
  });

  it("needs a ticket, and takes a model and an output file", () => {
    expect(parseIntentArgs(["--ticket", "t.md"])).toEqual({
      ticket: "t.md",
      model: "muse-spark-1.3",
    });
    expect(
      parseIntentArgs(["--ticket", "t.md", "--video", "v.mp4", "--model", "m", "--out", "o.json"]),
    ).toEqual({ ticket: "t.md", video: "v.mp4", model: "m", out: "o.json" });
    expect(() => parseIntentArgs([])).toThrow(UsageError);
    expect(() => parseIntentArgs(["--ticket", "t.md", "--wat"])).toThrow(UsageError);
  });
});
