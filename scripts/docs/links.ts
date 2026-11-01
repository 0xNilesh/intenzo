// pnpm docs:links (ROADMAP T7.3): every relative link in the repo's Markdown names a file or folder
// that exists, and every #anchor a heading GitHub would make. Offline: external links aren't
// fetched. Snapshot files are rendered output, not docs, so they're skipped. Exits 1 on any miss.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { REPO_ROOT } from "../probe/lib/env.ts";
import { brokenLinks } from "./lib/links.ts";

const listed = spawnSync("git", ["ls-files", "-z", "*.md"], { cwd: REPO_ROOT, encoding: "utf8" });
if (listed.status !== 0) {
  console.error(`git ls-files failed: ${listed.stderr}`);
  process.exit(2);
}
const paths = listed.stdout.split("\0").filter((p) => p !== "" && !p.includes("__snapshots__/"));
const files = new Map(paths.map((p) => [p, readFileSync(join(REPO_ROOT, p), "utf8")]));
const read = (path: string) => {
  const abs = join(REPO_ROOT, path);
  return files.get(path) ?? (existsSync(abs) ? readFileSync(abs, "utf8") : null);
};

const problems = brokenLinks(files, (path) => existsSync(join(REPO_ROOT, path)), read);
for (const p of problems) console.log(p);
console.log(
  problems.length === 0
    ? `docs:links: every link in ${files.size} Markdown files resolves`
    : `docs:links: ${problems.length} broken link(s) in ${files.size} Markdown files`,
);
process.exitCode = problems.length === 0 ? 0 : 1;
