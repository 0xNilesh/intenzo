# @intenzo/intentbench

IntentBench (ARCHITECTURE §31): record once, judge many. Twelve demo-shop branches implement four
tickets correctly, almost right, with an unrequested side effect, or broken. Every criterion has a
ground-truth label that a deterministic Playwright check proves on the branch's preview.

## Tickets

`tickets/<name>.md` is the ticket as written (what Muse Code implemented, and what the diff-only
arm will read); `tickets/<name>.criteria.json` holds its criteria in core's `Criterion` shape, the
same for every case and every arm.

| Ticket                                            | Criteria                                                                                                                                                                     |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `discount`: discount codes (demo-shop #5 as text) | C1 the "Discount (SAVE10)" line · C2 the total at $45.00 within 1 s · C3 OLD5 "This code has expired" · C4 the chart's discount slice                                        |
| `shipping`: free shipping progress                | C1 shipping $5.00 in a $55.00 total · C2 "Add $25.00 more for free shipping" · C3 at $75.00 "You've got free shipping!" and Shipping Free · C4 at $75.00 the total is $75.00 |
| `limit`: 5 per item                               | C1 "+" disabled at 5 · C2 "Limit 5 per item" · C3 Products refuses a sixth                                                                                                   |
| `undo`: undo Remove                               | C1 "Removed Ceramic mug" with Undo · C2 Undo restores the quantity · C3 Undo restores the totals                                                                             |

## Cases

`cases/<id>.json`, one per demo-shop branch `bench/<id>`, checked by `BenchCase` (`src/case.ts`).

| Case                    | Kind                  | Split    | Fails  | How it was made                          |
| ----------------------- | --------------------- | -------- | ------ | ---------------------------------------- |
| discount-correct        | correct               | held out | none   | Muse Code, unedited                      |
| shipping-correct        | correct               | held out | none   | Muse Code, unedited                      |
| limit-correct           | correct               | tuning   | none   | Muse Code, unedited                      |
| undo-correct            | correct               | held out | none   | Muse Code, unedited                      |
| discount-almost-right   | almost right (seeded) | held out | C2     | the total memoised on the lines only     |
| discount-almost-right-2 | almost right (seeded) | held out | C3     | "This code is not valid"                 |
| shipping-almost-right   | almost right (seeded) | tuning   | C3, C4 | `>` instead of `>=` at $75.00            |
| limit-almost-right      | almost right (seeded) | held out | C1     | "+" disabled only above the limit        |
| undo-almost-right       | almost right (seeded) | tuning   | C2, C3 | Undo restores quantity 1                 |
| shipping-side-effect    | side effect           | tuning   | none   | also renames "Checkout" to "Place order" |
| undo-side-effect        | side effect           | held out | none   | also drops the header's cart count       |
| limit-broken            | broken                | held out | all    | the cart page throws on every load       |

42 labelled criteria. Only held-out results are reported (§31), with the small-n caveat.

## Validate

```bash
pnpm bench:validate [--only=<case id prefix>]
```

It checks the case files and §31's split, then on each branch's Vercel preview runs every
criterion's check with a fresh shopper, and each side-effect check. Every observation must match
its label. It needs `gh` and demo-shop's `DEMO_SHOP_HOOK_SECRET` and `DEMO_SHOP_BYPASS_SECRET` in
`.env`. It makes no model calls and takes about 3 minutes.

## Cost

The four correct implementations: Muse Code in contributor mode, about $0.05 in all (2–4.5 min
each). Validation is free.

## Tests

```bash
pnpm --filter @intenzo/intentbench test   # the case schema, the split, a check for every criterion
```
