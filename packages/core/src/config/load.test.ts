import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { configFromFiles, formatProblems, parseConfig, readConfig } from "./load.ts";

const demoShop = readFileSync(
  new URL("../../fixtures/config/demo-shop.intenzo.yml", import.meta.url),
  "utf8",
);

const problems = (text: string) => {
  const result = parseConfig(text);
  return result.ok ? [] : result.problems;
};

describe("parseConfig", () => {
  it("parses demo-shop's real .intenzo.yml", () => {
    const result = parseConfig(demoShop);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.start.default).toBe("/cart");
    expect(result.config.isolation.session_hook).toBe("/api/test/session");
    expect(result.config.policy.approvers).toEqual(["sumithprabhu"]);
  });

  it("names an unknown top-level key, with its line", () => {
    expect(problems("version: 1\npolcy:\n  approvers: [a]\n")).toEqual([
      { path: "polcy", message: "unknown key", line: 2 },
    ]);
  });

  it("names an unknown nested key, with its line", () => {
    expect(problems("version: 1\npolicy:\n  approvers: [a]\n  auto_merge: true\n")).toEqual([
      { path: "policy.auto_merge", message: "unknown key", line: 4 },
    ]);
  });

  it("points at the line of a bad value", () => {
    const [problem] = problems("version: 1\npolicy:\n  max_agent_attempts: 0\n");
    expect(problem).toMatchObject({ path: "policy.max_agent_attempts", line: 3 });
  });

  it("rejects credentials written in the file, naming each key", () => {
    const text = "version: 1\nisolation:\n  users:\n    - username: qa\n      password: hunter2\n";
    // Both halves of the fix: the raw keys aren't allowed, and the secret-name keys are missing.
    const found = problems(text);
    expect(found).toHaveLength(4);
    expect(found).toEqual(
      expect.arrayContaining([
        { path: "isolation.users.0.username", message: "unknown key", line: 4 },
        { path: "isolation.users.0.password", message: "unknown key", line: 5 },
        expect.objectContaining({ path: "isolation.users.0.username_secret", line: 4 }),
        expect.objectContaining({ path: "isolation.users.0.password_secret", line: 4 }),
      ]),
    );
  });

  it("reports YAML syntax errors with their line, without throwing", () => {
    const [problem] = problems("version: 1\npolicy: [unclosed\n");
    expect(problem).toMatchObject({ path: "", line: 3 });
  });

  it("reports duplicate keys", () => {
    expect(problems("version: 1\nversion: 1\n")[0]).toMatchObject({ path: "", line: 2 });
  });

  it("requires the file to be a mapping", () => {
    expect(problems("- version: 1\n")).toEqual([
      { path: "", message: "must be a mapping of settings (key: value)", line: 1 },
    ]);
  });

  it("requires version in an empty file", () => {
    expect(problems("")[0]?.path).toBe("version");
  });
});

describe("readConfig", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const repo = (files: Record<string, string>) => {
    dir = mkdtempSync(join(tmpdir(), "intenzo-config-"));
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    return dir;
  };

  it("reads .intenzo.yml from a checkout", () => {
    const { file, result } = readConfig(repo({ ".intenzo.yml": demoShop }));
    expect(file).toBe(".intenzo.yml");
    expect(result.ok).toBe(true);
  });

  it("also accepts .intenzo.yaml", () => {
    expect(readConfig(repo({ ".intenzo.yaml": "version: 1\n" })).file).toBe(".intenzo.yaml");
  });

  it("runs on the defaults when there's no config file", () => {
    const { file, result } = readConfig(repo({}));
    expect(file).toBeNull();
    expect(result.ok && result.config.baseline.mode).toBe("merge_base");
  });

  it("refuses to guess between two config files", () => {
    const { result } = readConfig(
      repo({ ".intenzo.yml": "version: 1\n", ".intenzo.yaml": "version: 1\n" }),
    );
    expect(result.ok ? [] : result.problems).toEqual([
      { path: "", message: "found both .intenzo.yml and .intenzo.yaml; keep one" },
    ]);
  });
});

describe("configFromFiles", () => {
  // The Cloud reads the files through GitHub's contents API, not from a checkout.
  it("parses the one file it's given, naming it", () => {
    const { file, result } = configFromFiles([{ name: ".intenzo.yaml", text: demoShop }]);
    expect(file).toBe(".intenzo.yaml");
    expect(result.ok && result.config.start.default).toBe("/cart");
  });

  it("names the file's problems the same way", () => {
    const { result } = configFromFiles([{ name: ".intenzo.yml", text: "version: 2\n" }]);
    expect(result.ok ? [] : result.problems.map((p) => p.path)).toEqual(["version"]);
  });
});

describe("formatProblems", () => {
  it("renders file:line: path: message", () => {
    expect(
      formatProblems(".intenzo.yml", [
        { path: "policy.auto_merge", message: "unknown key", line: 4 },
        { path: "", message: "found both files; keep one" },
      ]),
    ).toBe(
      ".intenzo.yml:4: policy.auto_merge: unknown key\n.intenzo.yml: found both files; keep one",
    );
  });
});
