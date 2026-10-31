import { describe, expect, it } from "vitest";

import { ticketNumberOf, videoUrlsIn } from "./ticket.ts";

describe("ticketNumberOf (§17.2)", () => {
  it.each([
    ["Discount codes", "Closes #5", 5],
    ["Discount codes", "Fixes: #12\nSee #3 too", 12],
    ["Discount codes (#7)", "", 7],
    ["Discount codes", "Resolves sumithprabhu/demo-shop#5", 5],
    ["Discount codes", "Refs #9, and the design in #4", 9],
    ["Discount codes", "Part of the work. See #8.", 8],
    ["Discount codes", "Colors like &#35;123 and a/b#2 aren't tickets", null],
    ["Discount codes", null, null],
  ])("%j + %j → %j", (title, body, n) => {
    expect(ticketNumberOf(title, body)).toBe(n);
  });
});

describe("videoUrlsIn (§8)", () => {
  it("finds the recording a ticket attaches, once", () => {
    const html =
      '<p><a href="https://github.com/user-attachments/assets/cebd0ef1-5bd1-4c98-9f2d-607b0b328e3c">' +
      '<video src="https://github.com/user-attachments/assets/cebd0ef1-5bd1-4c98-9f2d-607b0b328e3c"></video></a></p>' +
      '<p>Shoppers should <a href="https://example.com/spec">see the spec</a>.</p>' +
      '<img src="https://private-user-images.githubusercontent.com/1/shot.png?jwt=x&amp;y=1">';
    expect(videoUrlsIn(html)).toEqual([
      "https://github.com/user-attachments/assets/cebd0ef1-5bd1-4c98-9f2d-607b0b328e3c",
    ]);
    expect(videoUrlsIn('<a href="https://cdn.example.com/pm.mp4?sig=1&amp;e=2">x</a>')).toEqual([
      "https://cdn.example.com/pm.mp4?sig=1&e=2",
    ]);
  });
});
