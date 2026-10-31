import { describe, expect, it } from "vitest";

import { roleNameIn } from "./explore.ts";

const text = `- main [ref=e8]:
  - textbox "Discount code" [ref=f1e7]
  - button "Say \\"hi\\"" [ref=e9] [cursor=pointer]: Hi
  - paragraph [ref=e10]: $50.00`;

describe("roleNameIn", () => {
  it("reads Playwright's role and name for a ref from its outline line", () => {
    expect(roleNameIn({ text }, "f1e7")).toEqual({ role: "textbox", name: "Discount code" });
    expect(roleNameIn({ text }, "e9")).toEqual({ role: "button", name: 'Say "hi"' });
    expect(roleNameIn({ text }, "e10")).toEqual({ role: "paragraph", name: "" });
    expect(roleNameIn({ text }, "e99")).toBeNull();
  });

  it("doesn't confuse e1 with e10", () => {
    expect(roleNameIn({ text: '- button "A" [ref=e10]\n- link "B" [ref=e1]' }, "e1")).toEqual({
      role: "link",
      name: "B",
    });
  });
});
