// Deterministic route candidates (ARCHITECTURE §18): which app routes a changed file belongs to,
// by Next.js's file conventions. The app router: a folder is a route segment, route groups
// "(shop)" and private folders "_x" add nothing, and a file in a route's folder (its page, layout
// or a colocated component) belongs to that route. The pages router: a file is a route.
// nextjs.org/docs/app/getting-started/project-structure

const SCRIPT = /\.(tsx|ts|jsx|js|mdx)$/;
const SPECIAL_PAGES = new Set(["_app", "_document", "_error", "404", "500"]);

/** The route a file belongs to, like "/cart" or "/products/[id]", or null for none. */
export function routeOf(file: string): string | null {
  const parts = file.replace(/^\.?\//, "").split("/");
  if (parts[0] === "src") parts.shift();
  const root = parts.shift();
  if (!root || !SCRIPT.test(parts.at(-1) ?? "")) return null;
  if (root === "app") {
    const name = parts.pop()!;
    if (/^route\.(ts|js)$/.test(name) || parts[0] === "api") return null; // API handlers
    // A file at app/'s root that isn't the page or a layout is shared by every route.
    if (parts.length === 0 && !/^(page|layout|loading|error|template|not-found)\./.test(name)) {
      return null;
    }
    if (parts.some((p) => p.startsWith("_") || p.startsWith("@"))) return null;
    const segments = parts.filter((p) => !/^\(.*\)$/.test(p));
    return `/${segments.join("/")}`;
  }
  if (root === "pages") {
    if (parts[0] === "api") return null;
    const name = parts.pop()!.replace(SCRIPT, "");
    if (parts.length === 0 && SPECIAL_PAGES.has(name)) return null;
    const segments = name === "index" ? parts : [...parts, name];
    return `/${segments.join("/")}`;
  }
  return null;
}

/** The distinct routes the changed files belong to, static ones first. */
export function routeCandidates(files: readonly string[]): string[] {
  const routes = [...new Set(files.map(routeOf).filter((r): r is string => r !== null))];
  const dynamic = (r: string) => r.includes("[");
  return [...routes.filter((r) => !dynamic(r)).sort(), ...routes.filter(dynamic).sort()];
}
