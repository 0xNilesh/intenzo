import { afterEach, describe, expect, it, vi } from "vitest";

import { BASETEN_BASE_URL, metaKey, REPO_ROOT, sparkOpenEndpoint } from "./env.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("metaKey", () => {
  it("prefers META_API_KEY (the name Muse Code reads)", () => {
    vi.stubEnv("META_API_KEY", "meta");
    vi.stubEnv("MODEL_API_KEY", "model");
    expect(metaKey()).toBe("meta");
  });

  it("falls back to MODEL_API_KEY (the name in the Meta docs)", () => {
    vi.stubEnv("META_API_KEY", "");
    vi.stubEnv("MODEL_API_KEY", "model");
    expect(metaKey()).toBe("model");
  });

  it("treats empty values as unset", () => {
    vi.stubEnv("META_API_KEY", "");
    vi.stubEnv("MODEL_API_KEY", "");
    expect(metaKey()).toBeUndefined();
  });
});

describe("sparkOpenEndpoint", () => {
  it("defaults to Baseten with BASETEN_API_KEY", () => {
    vi.stubEnv("SPARK_OPEN_BASE_URL", "");
    vi.stubEnv("SPARK_OPEN_API_KEY", "");
    vi.stubEnv("BASETEN_API_KEY", "bt");
    expect(sparkOpenEndpoint()).toEqual({ baseUrl: BASETEN_BASE_URL, key: "bt" });
  });

  it("uses any OpenAI-compatible host with its own key, trimming a trailing slash", () => {
    vi.stubEnv("SPARK_OPEN_BASE_URL", "https://api.fireworks.ai/inference/v1/");
    vi.stubEnv("SPARK_OPEN_API_KEY", "fw");
    vi.stubEnv("BASETEN_API_KEY", "bt");
    expect(sparkOpenEndpoint()).toEqual({
      baseUrl: "https://api.fireworks.ai/inference/v1",
      key: "fw",
    });
  });

  it("never sends the Baseten key to another host", () => {
    vi.stubEnv("SPARK_OPEN_BASE_URL", "https://api.fireworks.ai/inference/v1");
    vi.stubEnv("SPARK_OPEN_API_KEY", "");
    vi.stubEnv("BASETEN_API_KEY", "bt");
    expect(sparkOpenEndpoint().key).toBeUndefined();
  });

  it("treats empty values as unset", () => {
    vi.stubEnv("SPARK_OPEN_BASE_URL", "");
    vi.stubEnv("SPARK_OPEN_API_KEY", "");
    vi.stubEnv("BASETEN_API_KEY", "");
    expect(sparkOpenEndpoint().key).toBeUndefined();
  });
});

describe("REPO_ROOT", () => {
  it("points at the repository root", () => {
    expect(REPO_ROOT.endsWith("/")).toBe(true);
    expect(REPO_ROOT).not.toContain("/scripts/");
  });
});
