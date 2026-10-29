import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Absolute path of the repository root, with a trailing slash. */
export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** Loads the repo-root .env (gitignored) into process.env, if it exists. Values are never logged. */
export function loadDotEnv(): void {
  const file = `${REPO_ROOT}.env`;
  if (existsSync(file)) process.loadEnvFile(file);
}

/** Meta Model API key. Muse Code reads META_API_KEY; the Meta docs call it MODEL_API_KEY. */
export function metaKey(): string | undefined {
  return process.env.META_API_KEY || process.env.MODEL_API_KEY || undefined;
}

export function basetenKey(): string | undefined {
  return process.env.BASETEN_API_KEY || undefined;
}
