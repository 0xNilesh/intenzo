// Installs muse-fixer into a checkout of the target repo:
//   pnpm --filter @intenzo/muse-fixer install-into <path-to-checkout>
// Writes .github/workflows/muse-fixer.yml and .github/muse-fixer/{fix.ts,payload.ts}, with core's
// payload format in place of this package's re-export (the target doesn't have @intenzo/core).
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const target = process.argv[2];
if (!target) {
  console.error("usage: pnpm --filter @intenzo/muse-fixer install-into <path-to-checkout>");
  process.exit(2);
}
const root = resolve(process.env.INIT_CWD ?? process.cwd(), target);
if (!existsSync(join(root, ".git"))) {
  console.error(`${root} isn't a git checkout`);
  process.exit(2);
}
const here = new URL(".", import.meta.url).pathname;
const files: [string, string][] = [
  [join(here, "workflow.yml"), join(root, ".github/workflows/muse-fixer.yml")],
  [join(here, "src/fix.ts"), join(root, ".github/muse-fixer/fix.ts")],
  [
    join(here, "../../packages/core/src/fixer/payload.ts"),
    join(root, ".github/muse-fixer/payload.ts"),
  ],
];
for (const [from, to] of files) {
  mkdirSync(join(to, ".."), { recursive: true });
  copyFileSync(from, to);
  console.log(`wrote ${to.slice(root.length + 1)}`);
}
