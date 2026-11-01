# The demo (ARCHITECTURE §32)

## The ticket

[demo-shop #5 "Discount codes"](https://github.com/sumithprabhu/demo-shop/issues/5) is a PM screen
recording with narration. The storyboard calls it "#42"; that number was illustrative, and the real
ticket is #5. Its text only says the details are in the recording, so the criteria have to come from
the video: Voice Transcribe plus Spark watching it (§18).

The recording is made by `pnpm demo:pm-video` (`scripts/demo/pm-video.ts`): demo-shop's cart on
`main` (no discount codes yet), a browser address bar, a cursor, and narration by macOS `say`
(Samantha). It's about 36.5 s long. Re-run it if the cart's layout changes, and upload the new file
by hand (GitHub has no API for issue attachments).

What the PM says, when, and where the cursor is. These times are the ground truth for each
criterion's `sourceMediaAt` (T4.2):

| At     | Says                                                                                                                                        | Points at        | Criterion                                                 |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | --------------------------------------------------------- |
| 1.5 s  | "Hi! This is our cart page."                                                                                                                | the cart items   | (`repro.startPath = /cart`; the address bar shows it too) |
| 4.2 s  | "We need discount codes, with a field for the code right here, under the items."                                                            | under the items  | where the input goes                                      |
| 9.4 s  | "When I apply SAVE10, the order total should drop ten percent right away, with no refresh. So this fifty dollars should become forty-five." | the total        | **C2**                                                    |
| 18.5 s | "The discount should show up as its own line in the summary: SAVE10, minus five dollars."                                                   | the summary rows | **C1**                                                    |
| 24.4 s | "OLD5 is expired, so applying it should show: This code has expired."                                                                       | under the items  | **C3**                                                    |
| 30.0 s | "And the savings chart in the summary should show the discount slice."                                                                      | the chart        | **C4**                                                    |
| 34.0 s | "That's it. Thanks!"                                                                                                                        | —                |                                                           |

## The golden comment

`expected-comment.md` is the comment Intenzo should post on the almost-right PR
(`pr/discount-almost-right`). It's derived from that branch's proven ground truth
(`pnpm demo:ground-truth almost-right`, DECISIONS 2026-10-30 · Seeded demo branches). It's written
before the pipeline exists, so the pipeline is built to match it. It becomes a test fixture in P4
(the golden test), compared like this:

- **Must match exactly:**
  - the outcome in the header (`❌ 3/4 passed`)
  - each criterion's verdict, **matched by what the criterion is about** (the line ✅, the total ❌,
    the expired code ✅, the chart ✅), not by its number: the PM says the total first, so the intent
    step numbers it C1 (DECISIONS 2026-10-31 · Intent from the PM video; the owner's choice)
  - the total's readings line, as far as the criterion asks: `+0 s $50.00 · +1 s $50.00 · +3 s $50.00`.
    The PM never asks for the total to survive a reload, so the criterion read from the recording
    has no reload probe and no "after reload" reading
  - the ⚠️ line, from P5 (T5.6)
- **May differ:** the criteria's wording (the intent step phrases them), and every `{placeholder}`: report links, evidence times, GIF URLs, the base SHA, test counts, elapsed time and cost.

It isn't run through Prettier (`.prettierignore`), so its bytes stay exactly as written.
