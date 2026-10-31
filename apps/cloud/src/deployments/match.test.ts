import { describe, expect, it } from "vitest";

import {
  deploymentUrl,
  isPreviewEnvironment,
  isProductionEnvironment,
  onProductionDomain,
  previewUrl,
  type PreviewRules,
} from "./match.ts";

const VERCEL = { provider: "vercel", environment_prefix: "Preview" } as const;
const URL_A = "https://demo-shop-dly0m1skm-sumithprabhus-projects.vercel.app";

describe("isProductionEnvironment", () => {
  it.each([
    "Production",
    "production",
    "Production – demo-shop",
    "prod",
    "PROD-eu",
    "vercel-production",
    // Errs toward production: never used, which is the safe mistake.
    "product-preview",
  ])("%s is production", (name) => {
    expect(isProductionEnvironment(name)).toBe(true);
  });

  it.each(["Preview", "preview", "Preview – demo-shop", "staging", "Development"])(
    "%s isn't",
    (name) => {
      expect(isProductionEnvironment(name)).toBe(false);
    },
  );
});

describe("isPreviewEnvironment (§17.1)", () => {
  it.each([
    ["Preview", VERCEL, true],
    ["preview", VERCEL, true],
    ["Preview – demo-shop", VERCEL, true],
    ["Staging", VERCEL, false],
    ["Production", VERCEL, false],
    // A production environment never matches, whatever the prefix.
    ["Production", { ...VERCEL, environment_prefix: "P" }, false],
    ["Production – demo-shop", { ...VERCEL, environment_prefix: "prod" }, false],
    ["Preview", { ...VERCEL, environment_prefix: "P" }, true],
    // preview.project picks one project's deployments in a monorepo.
    ["Preview – demo-shop", { ...VERCEL, project: "Demo-Shop" }, true],
    ["Preview – docs", { ...VERCEL, project: "demo-shop" }, false],
  ] as const)("%s with %j → %s", (environment, preview, expected) => {
    expect(isPreviewEnvironment(environment, preview)).toBe(expected);
  });
});

describe("deploymentUrl", () => {
  it.each([
    [{ environment_url: URL_A, target_url: "https://vercel.com/logs" }, URL_A],
    [{ environment_url: null, target_url: URL_A }, URL_A],
    [{ environment_url: "", target_url: URL_A }, URL_A],
    [{ environment_url: "http://demo-shop.vercel.app" }, null],
    [{ environment_url: "not a url" }, null],
    [{}, null],
  ])("%j → %s", (status, url) => {
    expect(deploymentUrl(status)).toBe(url);
  });
});

describe("onProductionDomain", () => {
  it.each([
    ["https://shop.example.com/cart", ["example.com"], true],
    ["https://example.com", [".Example.com."], true],
    ["https://notexample.com", ["example.com"], false],
    [URL_A, ["example.com"], false],
    [URL_A, [], false],
  ])("%s on %j → %s", (url, domains, expected) => {
    expect(onProductionDomain(url, domains)).toBe(expected);
  });
});

describe("previewUrl", () => {
  const rules: PreviewRules = { preview: VERCEL, prodDomains: ["shop.example.com"] };

  it.each([
    ["a successful Preview", { environment: "Preview", state: "success", url: URL_A }, URL_A],
    ["a failed one", { environment: "Preview", state: "failure", url: URL_A }, null],
    ["one without a URL", { environment: "Preview", state: "success", url: null }, null],
    ["Production", { environment: "Production", state: "success", url: URL_A }, null],
    [
      "one on a production domain",
      { environment: "Preview", state: "success", url: "https://shop.example.com" },
      null,
    ],
  ])("%s → %s", (_name, deployment, url) => {
    expect(previewUrl(deployment, rules)).toBe(url);
  });
});
