import { configDefaults, defineConfig } from "vitest/config";

// One Vitest project per test layer (CONTRIBUTING.md §6). The layer is chosen by file suffix:
//   foo.test.ts           unit      fast, offline, no browser
//   foo.contract.test.ts  contract  pins behavior of things we don't own (fixtures, Playwright internals)
//   foo.browser.test.ts   browser   real Chromium against local pages
//   foo.live.test.ts      live      real model APIs (costs credits, never gates PRs)
const LAYERED = "{probe,gonogo}/**/*.{contract,browser,live}.test.ts";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["{probe,gonogo}/**/*.test.ts"],
          exclude: [...configDefaults.exclude, LAYERED],
        },
      },
      {
        test: {
          name: "contract",
          include: ["{probe,gonogo}/**/*.contract.test.ts"],
        },
      },
      {
        test: {
          name: "browser",
          include: ["{probe,gonogo}/**/*.browser.test.ts"],
          testTimeout: 60_000,
        },
      },
      {
        test: {
          name: "live",
          include: ["{probe,gonogo}/**/*.live.test.ts"],
          testTimeout: 180_000,
        },
      },
    ],
  },
});
