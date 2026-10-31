import { NO_USAGE, type ModelPort, type ModelRequest, type ModelResult } from "./port.ts";

// A model port for tests: each call gets the next scripted reply, which may be computed from the
// request (e.g. to pick a ref out of the outline the prompt carries). Replies are checked against
// the request's schema, exactly as a real reply would be.

export type ScriptedFn = (request: ModelRequest<unknown>, n: number) => unknown;
export type ScriptedReply = ScriptedFn | object | string | number | boolean | null;

export interface ScriptedPort extends ModelPort {
  readonly requests: ModelRequest<unknown>[];
}

export function scriptedPort(
  replies: readonly ScriptedReply[] | ((request: ModelRequest<unknown>, n: number) => unknown),
): ScriptedPort {
  const requests: ModelRequest<unknown>[] = [];
  return {
    requests,
    async call<T>(request: ModelRequest<T>): Promise<ModelResult<T>> {
      const n = requests.length;
      requests.push(request as ModelRequest<unknown>);
      const next = typeof replies === "function" ? replies : replies[n];
      if (next === undefined) {
        return {
          ok: false,
          error: "the script ran out of replies",
          raw: "",
          usage: NO_USAGE,
          ms: 0,
          requests: 1,
        };
      }
      const value =
        typeof next === "function"
          ? (next as (r: ModelRequest<unknown>, n: number) => unknown)(
              request as ModelRequest<unknown>,
              n,
            )
          : next;
      const parsed = request.schema.safeParse(value);
      const raw = JSON.stringify(value);
      return parsed.success
        ? { ok: true, output: parsed.data, raw, usage: NO_USAGE, ms: 0, requests: 1 }
        : {
            ok: false,
            error: `invalid reply: ${parsed.error.message}`,
            raw,
            usage: NO_USAGE,
            ms: 0,
            requests: 1,
          };
    },
  };
}
