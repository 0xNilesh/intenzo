import { describe, expect, it } from "vitest";

import { createDispatcher, type DispatchDeps } from "./dispatch.ts";
import type { AcceptedEvent } from "./intake.ts";

const AT = new Date("2026-10-31T09:00:01.000Z");

const event = (overrides: Partial<AcceptedEvent> = {}): AcceptedEvent => ({
  id: 7,
  deliveryId: "242ae330-d462-11f1-9155-4b63fde5d042",
  event: "pull_request",
  action: "opened",
  payload: { number: 2, token: "do-not-log-me" },
  ...overrides,
});

/** A dispatcher whose handlers and row updates all append to one `calls` list, in order. */
function setup(
  handlers: (calls: string[]) => DispatchDeps["handlers"],
  { markFailedThrows = false } = {},
) {
  const calls: string[] = [];
  const logs: string[] = [];
  const dispatch = createDispatcher({
    handlers: handlers(calls),
    markProcessed: async (id, at) => {
      calls.push(`processed ${id} at ${at.toISOString()}`);
    },
    markFailed: async (id, error) => {
      if (markFailedThrows) throw new Error("database down");
      calls.push(`failed ${id}: ${error.split("\n")[0]}`);
    },
    now: () => AT,
    log: (line) => logs.push(line),
  });
  return { dispatch, calls, logs };
}

const failing = (message: string) => async () => {
  throw new Error(message);
};

describe("createDispatcher", () => {
  it("runs the event's handler, then marks the row processed", async () => {
    const t = setup((calls) => ({
      pull_request: async (e) => {
        calls.push(`handled ${e.event}.${e.action}`);
      },
    }));

    await t.dispatch(event());

    expect(t.calls).toEqual(["handled pull_request.opened", `processed 7 at ${AT.toISOString()}`]);
    expect(t.logs).toEqual([]);
  });

  it("marks an event with no handler yet as processed", async () => {
    const t = setup(() => ({}));
    await t.dispatch(event({ event: "issues" }));
    expect(t.calls).toEqual([`processed 7 at ${AT.toISOString()}`]);
  });

  it("records a handler's error on the row and logs one line without the payload", async () => {
    const t = setup(() => ({ pull_request: failing("GitHub said 502") }));

    await expect(t.dispatch(event())).resolves.toBeUndefined();

    expect(t.calls).toEqual(["failed 7: Error: GitHub said 502"]);
    expect(t.logs).toEqual([
      "webhook 242ae330-d462-11f1-9155-4b63fde5d042 (pull_request.opened) failed: Error: GitHub said 502",
    ]);
    expect(t.logs.join("\n")).not.toContain("do-not-log-me");
  });

  it("still resolves when recording the failure fails too", async () => {
    const t = setup(() => ({ pull_request: failing("first failure") }), {
      markFailedThrows: true,
    });
    await expect(t.dispatch(event())).resolves.toBeUndefined();
    expect(t.logs).toHaveLength(1);
  });
});
