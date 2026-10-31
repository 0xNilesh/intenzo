// Finding a PR's ticket (ARCHITECTURE §17.2), the part that needs no GitHub call: an issue the PR
// body or title names, "Closes #5" before a bare "#5". GraphQL's closingIssuesReferences only
// covers PRs into the default branch (T0.4), so the text is read either way.

const KEYWORD =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?)\b[:\s]+(?:[\w.-]+\/[\w.-]+)?#(\d+)\b/gi;
const BARE = /(?<![\w/&])#(\d+)\b/g;

/** The issue number a PR's title and body point at, or null when they name none. */
export function ticketNumberOf(title: string, body: string | null): number | null {
  const text = `${title}\n${body ?? ""}`;
  const keyed = KEYWORD.exec(text);
  KEYWORD.lastIndex = 0;
  if (keyed) return Number(keyed[1]);
  const bare = BARE.exec(text);
  BARE.lastIndex = 0;
  return bare ? Number(bare[1]) : null;
}

/** The video attachments in an issue's rendered body (body_html), in order (§8). */
export function videoUrlsIn(bodyHtml: string): string[] {
  const urls = [...bodyHtml.matchAll(/(?:src|href)="(https:\/\/[^"]+)"/g)].map((m) =>
    m[1]!.replaceAll("&amp;", "&"),
  );
  const video = (u: string) =>
    /\/user-attachments\/assets\/[\w-]+$/.test(u) || /\.(mp4|mov|webm)(\?|$)/i.test(u);
  return [...new Set(urls.filter(video))];
}
