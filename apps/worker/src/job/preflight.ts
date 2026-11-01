// §19 step 1, the preflight: before anything is recorded, the job asks each preview for its root
// page directly, as a lane's bypass request does (§21.2), and follows no redirect. A PR preview that
// doesn't answer 2xx or 3xx ends the job as `preview_unreachable`: nothing could be recorded on it,
// and exploring it would only spend model calls (T7.1). A 5xx or a network error is asked again a
// few times, since a cold serverless function can fail its first request; a 4xx isn't (401:
// protected and no bypass; 404: no such deployment).

export interface PreflightResult {
  ok: boolean;
  /** The status the preview answered, when it answered. */
  status?: number;
  /** Why it didn't count: "HTTP 500", "timed out after 15 s", "ECONNREFUSED". */
  problem?: string;
}

export interface PreflightOptions {
  bypass?: string;
  fetch?: typeof fetch;
  /** The waits before each retry of a 5xx or a network error (tests make them short). */
  retryDelaysMs?: readonly number[];
  timeoutMs?: number;
}

export const PREFLIGHT_RETRY_DELAYS_MS = [2000, 5000];
const TIMEOUT_MS = 15_000;

/** The job's end when the PR preview didn't answer; run.ts reports it as `preview_unreachable`. */
export class PreviewUnreachable extends Error {
  readonly code = "preview_unreachable";
  constructor(message: string) {
    super(message);
    this.name = "PreviewUnreachable";
  }
}

function problemOf(err: unknown, timeoutMs: number): string {
  if (err instanceof Error && err.name === "TimeoutError") {
    return `timed out after ${timeoutMs / 1000} s`;
  }
  const cause = (err as { cause?: { code?: unknown } } | undefined)?.cause?.code;
  if (typeof cause === "string") return cause;
  return err instanceof Error ? err.message : String(err);
}

/** Whether `origin` answers its root page with 2xx or 3xx, asking again after a 5xx or no answer. */
export async function preflight(
  origin: string,
  options: PreflightOptions = {},
): Promise<PreflightResult> {
  const doFetch = options.fetch ?? fetch;
  const delays = options.retryDelaysMs ?? PREFLIGHT_RETRY_DELAYS_MS;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const url = new URL("/", origin).href;
  for (let attempt = 0; ; attempt++) {
    let result: PreflightResult;
    try {
      const res = await doFetch(url, {
        headers: options.bypass ? { "x-vercel-protection-bypass": options.bypass } : {},
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
      await res.body?.cancel();
      if (res.status < 400) return { ok: true, status: res.status };
      result = { ok: false, status: res.status, problem: `HTTP ${res.status}` };
      if (res.status < 500) return result;
    } catch (err) {
      result = { ok: false, problem: problemOf(err, timeoutMs) };
    }
    if (attempt >= delays.length) return result;
    await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
  }
}
