/** Safe access into untyped JSON: dig(body, "choices", 0, "message", "content"). */
export function dig(value: unknown, ...path: (string | number)[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}

export const asString = (value: unknown): string => (typeof value === "string" ? value : "");

export const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** Every string anywhere in a JSON value, depth-first. */
export function allStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(allStrings);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(allStrings);
  return [];
}

/** Every object key anywhere in a JSON value, deduplicated, in first-seen order. */
export function allKeys(value: unknown): string[] {
  const keys = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v !== null && typeof v === "object") {
      for (const [k, child] of Object.entries(v)) {
        keys.add(k);
        walk(child);
      }
    }
  };
  walk(value);
  return [...keys];
}
