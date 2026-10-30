import { describe, expect, it } from "vitest";

import { annotateHtml, labelSlots, type LabelledBox } from "./annotate.ts";

const box = (label: string, y: number, h = 20): LabelledBox => ({ label, bbox: [100, y, 200, h] });

describe("labelSlots", () => {
  it("puts each tag level with its box, top to bottom", () => {
    const slots = labelSlots([box("total", 400), box("discount line", 200)]);
    expect(slots.map((s) => [s.box.label, s.top])).toEqual([
      ["discount line", 193],
      ["total", 393],
    ]);
  });

  it("pushes overlapping tags down so they never overlap", () => {
    const slots = labelSlots([box("subtotal", 300), box("total", 305)]);
    expect(slots.map((s) => s.top)).toEqual([293, 333]);
  });

  it("orders tags by box centre, so a box nested in a taller one doesn't cross its lines", () => {
    const summary: LabelledBox = { label: "order summary", bbox: [780, 150, 340, 550] };
    const total: LabelledBox = { label: "order total", bbox: [1020, 256, 91, 38] };
    expect(labelSlots([summary, total]).map((s) => s.box.label)).toEqual([
      "order total",
      "order summary",
    ]);
  });

  it("never places a tag above the top edge", () => {
    expect(labelSlots([box("header", 0, 4)])[0]!.top).toBe(0);
  });
});

describe("annotateHtml", () => {
  it("escapes labels, which come from the ticket", () => {
    const html = annotateHtml("data:,", [box('<img src=x onerror="alert(1)">', 10)]);
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  it("draws one red frame per box", () => {
    const html = annotateHtml("data:,", [box("a", 10), box("b", 300)]);
    expect(html.match(/border:4px solid red/g)).toHaveLength(2);
  });
});
