const SECRET_KEY = /authorization|access_?token|api_?key|secret|password/i;
const MAX_DEPTH = 8;

/**
 * Summarizes a request or response body so it can be stored in probes/results.json: scalars are
 * kept, base64 data URLs and long strings are collapsed, arrays keep their first item and a
 * count, and anything under a secret-looking key is redacted.
 */
export function shapeOf(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return describeString(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return [];
    const head = shapeOf(value[0], depth + 1);
    return value.length === 1 ? [head] : [head, `…${value.length - 1} more`];
  }
  if (typeof value === "object") {
    if (depth >= MAX_DEPTH) return "<nested>";
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        SECRET_KEY.test(k) ? "<redacted>" : shapeOf(v, depth + 1),
      ]),
    );
  }
  return `<${typeof value}>`;
}

export function describeString(s: string): string {
  const dataUrl = /^data:([^;,]+)(?:;base64)?,/.exec(s);
  if (dataUrl) return `<data-url ${dataUrl[1]} · ${s.length - dataUrl[0].length} chars>`;
  return s.length > 160 ? `${s.slice(0, 120)}… <${s.length} chars>` : s;
}
