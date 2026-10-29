export interface HttpResult {
  /** HTTP status, or 0 when the request never got a response (network error, timeout). */
  status: number;
  ok: boolean;
  ms: number;
  headers: Headers;
  /** Parsed JSON when the body is JSON, otherwise the raw text. */
  body: unknown;
  text: string;
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  json?: unknown;
  form?: FormData;
  timeoutMs?: number;
}

/** fetch() wrapper that times the call and never throws: failures come back as a result. */
export async function request(url: string, options: RequestOptions = {}): Promise<HttpResult> {
  const { json, form, timeoutMs = 180_000 } = options;
  const started = performance.now();
  try {
    const res = await fetch(url, {
      method: options.method ?? (json !== undefined || form ? "POST" : "GET"),
      headers: {
        ...(json !== undefined && { "Content-Type": "application/json" }),
        ...options.headers,
      },
      body: form ?? (json !== undefined ? JSON.stringify(json) : undefined),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    return {
      status: res.status,
      ok: res.ok,
      ms: performance.now() - started,
      headers: res.headers,
      body: parseJson(text),
      text,
    };
  } catch (err) {
    const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return {
      status: 0,
      ok: false,
      ms: performance.now() - started,
      headers: new Headers(),
      body: text,
      text,
    };
  }
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Rate-limit and request-id headers worth keeping with a result. */
export function pickLimits(headers: Headers): Record<string, string> {
  const kept: Record<string, string> = {};
  headers.forEach((value, name) => {
    if (/^x-ratelimit-|^retry-after$|request-id$/i.test(name)) kept[name] = value;
  });
  return kept;
}

/**
 * True when a failed call looks like the API refusing the capability itself (a 4xx that names the
 * modality, content type or model) rather than an outage, auth problem or our own bug.
 */
export function looksUnsupported(status: number, text: string): boolean {
  return (
    [400, 404, 415, 422].includes(status) &&
    /unsupport|not support|not allowed|not available|invalid (content|input|part|type)|modality|content.?type|video|image|audio|model_not_found/i.test(
      text,
    )
  );
}

export function errorText(result: Pick<HttpResult, "status" | "text">): string {
  const prefix = result.status === 0 ? "no response" : `HTTP ${result.status}`;
  return `${prefix}: ${result.text.replace(/\s+/g, " ").slice(0, 300)}`;
}
