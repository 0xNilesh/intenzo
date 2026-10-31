import type { Locator } from "playwright";
import { describe, expect, it } from "vitest";

import { DEFAULT_DENY_TEXT, type NavAction } from "../schema/index.ts";
import { deniedTerm, guardAction, type GuardContext } from "./guard.ts";

interface Fake {
  count?: number;
  texts?: string[];
  editable?: boolean;
  isSelect?: boolean;
}

/** A stand-in for the page: each ref resolves to a fake locator with the given facts. */
function context(elements: Record<string, Fake>, extra: Partial<GuardContext> = {}): GuardContext {
  return {
    origin: "https://shop-git-pr-1.vercel.app",
    allowedNavigationOrigins: [],
    refs: new Set(Object.keys(elements)),
    resolve: (ref) => {
      const el = elements[ref] ?? { count: 0 };
      return {
        count: async () => el.count ?? 1,
        evaluate: async () => ({
          texts: el.texts ?? [],
          editable: el.editable ?? false,
          isSelect: el.isSelect ?? false,
        }),
      } as unknown as Locator;
    },
    denyText: [...DEFAULT_DENY_TEXT],
    ...extra,
  };
}

const step = (action: NavAction["action"], rest: Partial<NavAction> = {}): NavAction => ({
  thought: "",
  phase: "setup",
  action,
  status: "continue",
  ...rest,
});

describe("guardAction", () => {
  it("lets ordinary actions through", async () => {
    const ctx = context({
      e1: { texts: ["Apply"] },
      e2: { editable: true },
      e3: { isSelect: true },
    });
    for (const action of [
      step({ op: "click", ref: "e1" }),
      step({ op: "fill", ref: "e2", value: "SAVE10" }),
      step({ op: "select", ref: "e3", option: "2" }),
      step({ op: "goto", path: "/cart" }),
      step({ op: "press", key: "Enter" }),
      step({ op: "scroll", direction: "down" }),
      step({ op: "back" }),
      { thought: "", phase: "trigger", status: "give_up", reason: "trigger_not_found" } as const,
    ]) {
      expect(await guardAction(action, ctx)).toEqual({ ok: true });
    }
  });

  it("rejects a goto that leaves the app, even when the path looks local", async () => {
    const ctx = context({});
    for (const path of ["/\\evil.example/login", "/\\\\evil.example"]) {
      expect(await guardAction(step({ op: "goto", path }), ctx)).toMatchObject({
        ok: false,
        code: "off_origin",
      });
    }
  });

  it("allows a goto to an extra navigation origin", async () => {
    const ctx = context({}, { allowedNavigationOrigins: ["https://evil.example"] });
    expect(await guardAction(step({ op: "goto", path: "/\\evil.example/login" }), ctx)).toEqual({
      ok: true,
    });
  });

  it("rejects 'Delete account' and other denied text, whatever the case", async () => {
    const ctx = context({ e1: { texts: ["Delete account"] }, e2: { texts: ["", "PAY NOW"] } });
    const first = await guardAction(step({ op: "click", ref: "e1" }), ctx);
    expect(first).toMatchObject({ ok: false, code: "denied" });
    expect(first.ok || first.message).toContain('"Delete account"');
    expect(await guardAction(step({ op: "click", ref: "e2" }), ctx)).toMatchObject({
      code: "denied",
    });
  });

  it("rejects an unknown ref with a message naming it", async () => {
    const result = await guardAction(step({ op: "click", ref: "e99" }), context({ e1: {} }));
    expect(result).toMatchObject({ ok: false, code: "unknown_ref" });
    expect(result.ok || result.message).toMatch(/^ref e99 isn't in the current outline/);
  });

  it("checks watch refs too", async () => {
    const done = step(
      { op: "click", ref: "e1" },
      { status: "trigger_done", watch: [{ label: "total", ref: "e7" }] },
    );
    expect(await guardAction(done, context({ e1: {} }))).toMatchObject({ code: "unknown_ref" });
  });

  it("rejects a ref that's gone from the page or matches several elements", async () => {
    const ctx = context({ e1: { count: 0 }, e2: { count: 2 } });
    expect(await guardAction(step({ op: "click", ref: "e1" }), ctx)).toMatchObject({
      code: "unknown_ref",
    });
    expect(await guardAction(step({ op: "click", ref: "e2" }), ctx)).toMatchObject({
      code: "ambiguous_ref",
    });
  });

  it("rejects filling something that isn't a field, and selecting on a non-select", async () => {
    const ctx = context({ e1: { texts: ["Apply"] } });
    expect(await guardAction(step({ op: "fill", ref: "e1", value: "x" }), ctx)).toMatchObject({
      code: "bad_op",
    });
    expect(await guardAction(step({ op: "select", ref: "e1", option: "x" }), ctx)).toMatchObject({
      code: "bad_op",
    });
  });
});

describe("deniedTerm", () => {
  it.each([
    ["Delete account", "delete"],
    ["Pay now", "pay"],
    ["Remove Ceramic mug", "remove"],
    ["Cancel   subscription", "cancel subscription"],
  ])("denies %s", (text, term) => {
    expect(deniedTerm([text], DEFAULT_DENY_TEXT)?.term).toBe(term);
  });
  it.each(["Apply", "Display options", "Add to cart", "Payload", "Checkout"])(
    "allows %s",
    (text) => {
      expect(deniedTerm([text], DEFAULT_DENY_TEXT)).toBeNull();
    },
  );
});
