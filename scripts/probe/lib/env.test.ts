import { afterEach, describe, expect, it, vi } from "vitest";

import { basetenKey, metaKey, REPO_ROOT } from "./env.ts";

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

describe("basetenKey", () => {
  it("treats an empty BASETEN_API_KEY as unset", () => {
    vi.stubEnv("BASETEN_API_KEY", "");
    expect(basetenKey()).toBeUndefined();
  });
});

describe("REPO_ROOT", () => {
  it("points at the repository root", () => {
    expect(REPO_ROOT.endsWith("/")).toBe(true);
    expect(REPO_ROOT).not.toContain("/scripts/");
  });
});
