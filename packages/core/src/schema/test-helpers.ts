import type { z } from "zod";

/** A schema's validation issues as "path: message" strings ("(root)" for the top level). */
export function issues(schema: z.ZodType, value: unknown): string[] {
  const result = schema.safeParse(value);
  if (result.success) return [];
  return result.error.issues.map(
    (i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`,
  );
}
