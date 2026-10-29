import { describe, expect, it } from "vitest";

import { errorText, looksUnsupported, parseJson, pickLimits, request } from "./http.ts";

describe("looksUnsupported", () => {
  it("is true for a 4xx that names the modality or model", () => {
    expect(looksUnsupported(400, '{"error":"video_url content parts are not supported"}')).toBe(
      true,
    );
    expect(looksUnsupported(404, '{"code":"model_not_found"}')).toBe(true);
    expect(looksUnsupported(415, "Unsupported media type")).toBe(true);
  });

  it("is false for auth problems, rate limits, outages and unrelated 400s", () => {
    expect(looksUnsupported(401, "invalid api key")).toBe(false);
    expect(looksUnsupported(429, "video rate limit")).toBe(false);
    expect(looksUnsupported(500, "video pipeline crashed")).toBe(false);
    expect(looksUnsupported(400, "max_completion_tokens must be positive")).toBe(false);
  });
});

describe("pickLimits", () => {
  it("keeps rate-limit, retry-after and request-id headers only", () => {
    const headers = new Headers({
      "x-ratelimit-remaining-requests": "2999",
      "retry-after": "2",
      "x-request-id": "req_1",
      "content-type": "application/json",
      "set-cookie": "a=b",
    });
    expect(pickLimits(headers)).toEqual({
      "x-ratelimit-remaining-requests": "2999",
      "retry-after": "2",
      "x-request-id": "req_1",
    });
  });
});

describe("errorText", () => {
  it("names the status, flattens whitespace and caps the length", () => {
    expect(errorText({ status: 400, text: "bad\n  request" })).toBe("HTTP 400: bad request");
    expect(errorText({ status: 0, text: "TimeoutError: aborted" })).toBe(
      "no response: TimeoutError: aborted",
    );
    expect(errorText({ status: 500, text: "x".repeat(1000) }).length).toBeLessThanOrEqual(310);
  });
});

describe("parseJson", () => {
  it("returns parsed JSON, or the text when it isn't JSON", () => {
    expect(parseJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseJson("<html>")).toBe("<html>");
  });
});

describe("request", () => {
  it("turns a network failure into a status-0 result instead of throwing", async () => {
    const res = await request("http://127.0.0.1:9/never", { timeoutMs: 2000 });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(0);
    expect(res.text.length).toBeGreaterThan(0);
  });
});
