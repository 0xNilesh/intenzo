# Demo branch ground truth (ROADMAP T0.6)

`demo-shop`'s demo branches implement ticket #42 (discount codes). One is correct; one is
almost right. Everything later in the project is scored against what they actually do: the golden
comment (T0.7), the P1 gate's readings and the demo itself. `pnpm demo:ground-truth` proves that
behavior on the real deployments.

```bash
pnpm demo:ground-truth correct                    # pr/discount-correct, at its Vercel alias
pnpm demo:ground-truth almost-right               # pr/discount-almost-right
pnpm demo:ground-truth almost-right --url=http://localhost:3101   # any other deployment
```

Every check starts from a brand-new shopper made by demo-shop's signed session hook, the way
Intenzo records. It applies a code, and reads at Tt+0, +1 s and +3 s (ARCHITECTURE §21.3). The
command exits 1 unless every observation equals the branch's ground truth:

| Criterion (§32) | Check                                            | `correct`                          | `almost-right`            |
| --------------- | ------------------------------------------------ | ---------------------------------- | ------------------------- |
| C1              | discount line at Tt+0                            | `Discount (SAVE10) −$5.00`         | same                      |
| C2              | total at Tt+0 / +1 s / +3 s, then after a reload | `$45.00` ×3; `$45.00`              | **`$50.00` ×3; `$45.00`** |
| C3              | the OLD5 toast within 1 s                        | `This code has expired`            | same                      |
| C4              | the savings chart at 344°, before Apply → Tt+1 s | amber → green (the discount slice) | same                      |
| change (§24)    | the cart's button to `/checkout`                 | `Checkout`                         | **`Continue`**            |

- **Needs** `DEMO_SHOP_HOOK_SECRET` (the Vercel Preview value of demo-shop's `INTENZO_HOOK_SECRET`) and, for protected previews, `DEMO_SHOP_BYPASS_SECRET` in `.env`, plus Playwright's Chromium. No model calls; it costs nothing.
- **Why this is here and not in demo-shop:** the repo under test shouldn't carry an answer key for its own planted bug. If it did, the fixer agent and IntentBench's diff-only arm could read it.

## The PM video (T0.7)

```bash
pnpm demo:pm-video          # → probes/demo/pm-ticket.mp4 (gitignored), about 36.5 s
```

It records demo-shop's cart on `main` with a visible cursor and a browser address bar, while a voice (macOS `say`, Samantha, or `espeak-ng`) narrates ticket #5. The cursor points at each part of the page as the narration mentions it. Every line starts when its gesture does, so the narration matches the screen. `demo/README.md` lists what's said when, which is the ground truth for each criterion's `sourceMediaAt`. Then upload the MP4 to the ticket by hand: GitHub has no API for issue attachments.
