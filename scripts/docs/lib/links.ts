// The repo's Markdown links, checked offline (ROADMAP T7.3): a relative link must name a file or
// folder that exists, and an #anchor must name a heading of the Markdown file it points at, as
// GitHub slugs them. External links (http, mailto) are left alone: checking them needs the network.
import { dirname, join, normalize } from "node:path";

export interface Link {
  target: string;
  line: number;
}

const FENCE = /^\s*(```|~~~)/;
const INLINE_CODE = /`+[^`]*`+/g;
// [text](target "title") and ![alt](target); the text may hold one level of brackets.
const INLINE_LINK = /!?\[(?:[^[\]]|\[[^\]]*\])*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
// [ref]: target
const REFERENCE = /^\s{0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s+"[^"]*")?\s*$/;

/** Every link and image target in a Markdown text, outside code blocks and code spans. */
export function linksIn(markdown: string): Link[] {
  const links: Link[] = [];
  let fenced = false;
  markdown.split("\n").forEach((text, i) => {
    if (FENCE.test(text)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    const line = text.replace(INLINE_CODE, "");
    const reference = REFERENCE.exec(line);
    if (reference) links.push({ target: reference[1]!, line: i + 1 });
    for (const m of line.matchAll(INLINE_LINK)) links.push({ target: m[1]!, line: i + 1 });
  });
  return links;
}

/**
 * A heading's anchor as GitHub makes it (github-slugger): lower case, punctuation and symbols
 * (emoji, "·", "§", "`", ":") dropped, and each space a hyphen, so "✅ Phase 6 gate" is
 * "-phase-6-gate". Link syntax keeps only its text.
 */
export function githubSlug(heading: string): string {
  return heading
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, "")
    .replace(/ /g, "-");
}

/** The anchors of a Markdown text's headings; a repeated one gets -1, -2… as on GitHub. */
export function anchorsIn(markdown: string): Set<string> {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (FENCE.test(line)) fenced = !fenced;
    const heading = !fenced && /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!heading) continue;
    const slug = githubSlug(heading[1]!.trim());
    const n = seen.get(slug) ?? 0;
    seen.set(slug, n + 1);
    anchors.add(n === 0 ? slug : `${slug}-${n}`);
  }
  return anchors;
}

const EXTERNAL = /^[a-z][a-z0-9+.-]*:/i;
/** A template's slot, as in the golden comment's `{report}#C1`: filled in later, not a link yet. */
const PLACEHOLDER = /^\{[\w.]+\}/;

/**
 * The broken links of these Markdown files (repo-relative path → text), as "file:line: why".
 * `exists` says whether a repo-relative path is a file or a folder.
 */
export function brokenLinks(
  files: ReadonlyMap<string, string>,
  exists: (path: string) => boolean,
  read: (path: string) => string | null = (path) => files.get(path) ?? null,
): string[] {
  const problems: string[] = [];
  for (const [file, text] of files) {
    for (const { target, line } of linksIn(text)) {
      if (EXTERNAL.test(target) || PLACEHOLDER.test(target)) continue;
      const [rawPath, anchor] = target.split("#", 2) as [string, string | undefined];
      let path = file;
      if (rawPath !== "") {
        const decoded = decodeURI(rawPath);
        path = normalize(decoded.startsWith("/") ? decoded.slice(1) : join(dirname(file), decoded));
        if (path.startsWith("..") || !exists(path)) {
          problems.push(`${file}:${line}: ${target}: no such file`);
          continue;
        }
      }
      if (anchor === undefined || anchor === "" || !path.endsWith(".md")) continue;
      const markdown = read(path);
      if (markdown !== null && !anchorsIn(markdown).has(decodeURIComponent(anchor).toLowerCase())) {
        problems.push(`${file}:${line}: ${target}: no heading #${anchor} in ${path}`);
      }
    }
  }
  return problems;
}
