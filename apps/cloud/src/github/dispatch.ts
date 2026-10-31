// What happens to a stored webhook event once GitHub has its answer. Event types get handlers as
// the roadmap reaches them (pull_request in T2.2, deployment_status in T2.3, …). An event with no
// handler yet is only stored.
import type { AcceptedEvent } from "./intake.ts";

export type EventHandler = (event: AcceptedEvent) => Promise<void>;

export interface DispatchDeps {
  handlers: Readonly<Partial<Record<string, EventHandler>>>;
  markProcessed: (id: number, at: Date) => Promise<void>;
  markFailed: (id: number, error: string) => Promise<void>;
  now: () => Date;
  /** One line per failure: the delivery and the error, never the payload. */
  log: (line: string) => void;
}

/** Runs the event's handler and records the outcome on its webhook_events row. Never throws. */
export function createDispatcher(deps: DispatchDeps): (event: AcceptedEvent) => Promise<void> {
  return async (event) => {
    try {
      await deps.handlers[event.event]?.(event);
      await deps.markProcessed(event.id, deps.now());
    } catch (err) {
      const error = err instanceof Error ? (err.stack ?? err.message) : String(err);
      const name = event.action ? `${event.event}.${event.action}` : event.event;
      deps.log(`webhook ${event.deliveryId} (${name}) failed: ${error.split("\n")[0]}`);
      // The row stays unprocessed either way; a failure to say why must not escape after().
      await deps.markFailed(event.id, error).catch(() => undefined);
    }
  };
}
