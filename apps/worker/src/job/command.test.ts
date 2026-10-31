import { afterEach, describe, expect, it } from "vitest";

import { exitOnSignals } from "./command.ts";

describe("exitOnSignals", () => {
  afterEach(() => {
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGINT");
  });

  it("exits at once on the shim's SIGTERM, and on SIGINT, before any other handler can stall it", () => {
    const codes: number[] = [];
    exitOnSignals((code) => codes.push(code));
    process.emit("SIGTERM");
    process.emit("SIGINT");
    expect(codes).toEqual([143, 130]);
  });
});
