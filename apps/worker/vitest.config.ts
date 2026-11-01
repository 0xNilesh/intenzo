import { configDefaults, defineConfig } from "vitest/config";

// One Vitest project per test layer (CONTRIBUTING.md §6). The layer is chosen by file suffix:
//   foo.test.ts           unit      fast, offline, no browser
//   foo.contract.test.ts  contract  pins behavior of things we don't own (fixtures, Playwright internals)
//   foo.browser.test.ts   browser   real Chromium against local pages
//   foo.faults.test.ts    faults    a fault injected end to end, against local fakes (T7.1)
//   foo.live.test.ts      live      real model APIs (costs credits, never gates PRs)
const LAYERED = "src/**/*.{contract,browser,faults,live}.test.ts";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["src/**/*.test.ts"],
          exclude: [...configDefaults.exclude, LAYERED],
        },
      },
      {
        test: {
          name: "contract",
          include: ["src/**/*.contract.test.ts"],
        },
      },
      {
        test: {
          name: "browser",
          include: ["src/**/*.browser.test.ts"],
          testTimeout: 60_000,
        },
      },
      {
        test: {
          name: "faults",
          include: ["src/**/*.faults.test.ts"],
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: "live",
          include: ["src/**/*.live.test.ts"],
          testTimeout: 180_000,
        },
      },
    ],
  },
});
