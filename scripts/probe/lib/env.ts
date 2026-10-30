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

/** Default Muse Spark Open host: Baseten Model APIs (OpenAI-compatible). */
export const BASETEN_BASE_URL = "https://inference.baseten.co/v1";

export interface SparkOpenEndpoint {
  baseUrl: string;
  key: string | undefined;
}

/**
 * Where to reach Muse Spark Open: any OpenAI-compatible host via SPARK_OPEN_BASE_URL +
 * SPARK_OPEN_API_KEY (e.g. Fireworks), otherwise Baseten with BASETEN_API_KEY. The Baseten key
 * is only ever sent to Baseten.
 */
export function sparkOpenEndpoint(): SparkOpenEndpoint {
  const baseUrl = (process.env.SPARK_OPEN_BASE_URL || BASETEN_BASE_URL).replace(/\/+$/, "");
  const key =
    process.env.SPARK_OPEN_API_KEY ||
    (baseUrl === BASETEN_BASE_URL ? process.env.BASETEN_API_KEY : undefined) ||
    undefined;
  return { baseUrl, key };
}
