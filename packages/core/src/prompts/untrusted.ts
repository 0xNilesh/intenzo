// §13: everything a model reads that Intenzo didn't write (a ticket, a transcript, a PR body, a
// page) goes inside an <untrusted> block. A closing tag inside the content is defused, so the
// content can't end its own block and pose as Intenzo's instructions.

const CLOSING = /<\s*\/\s*untrusted/gi;

export function untrusted(source: string, content: string, attrs: Record<string, string> = {}) {
  const extra = Object.entries(attrs)
    .map(([k, v]) => ` ${k}="${v.replaceAll('"', "'")}"`)
    .join("");
  const safe = content.replace(CLOSING, "</untrusted_");
  return `<untrusted source="${source}"${extra}>\n${safe}\n</untrusted>`;
}
