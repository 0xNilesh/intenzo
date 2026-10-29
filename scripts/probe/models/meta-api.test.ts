import { describe, expect, it } from "vitest";

import { chatText, responsesText } from "./meta-api.ts";

describe("chatText", () => {
  it("reads choices[0].message.content", () => {
    expect(chatText({ choices: [{ message: { content: "start=50, end=45" } }] })).toBe(
      "start=50, end=45",
    );
  });

  it("is empty when content is missing or null", () => {
    expect(chatText({ choices: [{ message: { content: null } }] })).toBe("");
    expect(chatText({})).toBe("");
  });
});

describe("responsesText", () => {
  it("prefers the output_text convenience field", () => {
    expect(responsesText({ output_text: "OK", output: [] })).toBe("OK");
  });

  it("otherwise joins the text parts of output messages, skipping other items", () => {
    const body = {
      output: [
        { type: "reasoning", summary: [] },
        {
          type: "message",
          content: [
            { type: "output_text", text: "start=50, " },
            { type: "output_text", text: "end=45" },
          ],
        },
      ],
    };
    expect(responsesText(body)).toBe("start=50, end=45");
  });
});
