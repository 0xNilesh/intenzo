// A small GitHub REST client for one App installation: GETs whose answers are checked against the
// fields Intenzo reads (docs.github.com/en/rest, API version 2022-11-28). The Cloud is the only code
// with GitHub credentials (§29).
import type { z } from "zod";

export const GITHUB_API = "https://api.github.com";
export const GITHUB_HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "intenzo-cloud",
};
const TIMEOUT_MS = 10_000;

/** A failed GitHub call. Its message is the request and GitHub's own answer, never a credential. */
export class GitHubError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
  }
}

/** "403 Resource not accessible by integration": the status and GitHub's message, cut short. */
export async function errorText(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  let message = text;
  try {
    message = (JSON.parse(text) as { message?: string }).message ?? text;
  } catch {
    // Not JSON: keep the text.
  }
  return `${response.status} ${message.slice(0, 200)}`.trim();
}

export interface GitHub {
  /** GETs a JSON resource and checks the fields Intenzo reads. Null when GitHub answers 404. */
  get<T>(path: string, schema: z.ZodType<T>): Promise<T | null>;
  /** POSTs or PATCHes JSON and checks the answer. Null when GitHub answers 404. */
  send<T>(
    method: "POST" | "PATCH",
    path: string,
    body: unknown,
    schema: z.ZodType<T>,
  ): Promise<T | null>;
  /** A file's text at a ref, through the contents API. Null when there's no such file. */
  file(repo: string, path: string, ref: string): Promise<string | null>;
}

/** A client that authenticates every call with `token()`: an installation token (app-auth.ts). */
export function githubClient(token: () => Promise<string>): GitHub {
  async function call(
    method: string,
    path: string,
    accept: string,
    body?: unknown,
  ): Promise<Response | null> {
    const headers: Record<string, string> = {
      ...GITHUB_HEADERS,
      Accept: accept,
      Authorization: `Bearer ${await token()}`,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(`${GITHUB_API}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new GitHubError(response.status, `${method} ${path}: ${await errorText(response)}`);
    }
    return response;
  }
  return {
    async get(path, schema) {
      const response = await call("GET", path, GITHUB_HEADERS.Accept);
      return response && schema.parse(await response.json());
    },
    async send(method, path, body, schema) {
      const response = await call(method, path, GITHUB_HEADERS.Accept, body);
      return response && schema.parse(await response.json());
    },
    async file(repo, path, ref) {
      // docs.github.com/en/rest/repos/contents#get-repository-content: the raw media type
      // answers with the file's bytes instead of base64 in JSON.
      const query = new URLSearchParams({ ref });
      const response = await call(
        "GET",
        `/repos/${repo}/contents/${path}?${query}`,
        "application/vnd.github.raw+json",
      );
      return response && response.text();
    },
  };
}

/** A ref as one URL path segment per part: branch names may contain slashes. */
export function refPath(ref: string): string {
  return ref.split("/").map(encodeURIComponent).join("/");
}
