// A fake GitHub REST API for unit tests: msw answers fetch() calls to api.github.com in-process, so
// the tests stay offline. Each request is logged as "GET /path?query", so a test can check which
// calls were made and that some never were. A request no route answers fails the test, even when
// the code under test catches the error it gets.
import { http } from "msw/http";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll } from "vitest";

import { GITHUB_API } from "./api.ts";

/** What a route answers: a JSON body, or a Response for anything else (a 404, raw text). */
type Reply = (request: Request) => unknown;

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
export const notFound = () => json({ message: "Not Found" }, 404);

export function fakeGitHub() {
  const server = setupServer();
  const calls: string[] = [];
  const unanswered: string[] = [];
  beforeAll(() =>
    server.listen({
      onUnhandledFrame({ frame, defaults }) {
        const request = (frame.data as { request?: Request }).request;
        unanswered.push(request ? `${request.method} ${new URL(request.url).pathname}` : "?");
        defaults.error();
      },
    }),
  );
  afterEach(() => {
    server.resetHandlers();
    calls.length = 0;
    const missed = unanswered.splice(0);
    if (missed.length > 0) throw new Error(`No fake GitHub route answered: ${missed.join(", ")}`);
  });
  afterAll(() => server.close());

  const route = (method: "get" | "post" | "patch", path: string, reply: Reply) =>
    server.use(
      // msw matches the path only; the query is logged for the test to check.
      http[method](`${GITHUB_API}${path}`, async ({ request }) => {
        const url = new URL(request.url);
        calls.push(`${method.toUpperCase()} ${url.pathname}${url.search}`);
        const answer = await reply(request);
        return answer instanceof Response ? answer : json(answer);
      }),
    );
  const reply = (answer: unknown): Reply =>
    typeof answer === "function" ? (answer as Reply) : () => answer;

  return {
    calls,
    get: (path: string, answer: unknown) => route("get", path, reply(answer)),
    post: (path: string, answer: unknown) => route("post", path, reply(answer)),
    patch: (path: string, answer: unknown) => route("patch", path, reply(answer)),
    /** An installation that mints `token`, valid for an hour. */
    installation: (id: number, token = "ghs_test") =>
      route("post", `/app/installations/${id}/access_tokens`, () => ({
        token,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      })),
  };
}
