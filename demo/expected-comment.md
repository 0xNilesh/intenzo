### Intenzo · verified against #5 "Discount codes"           ❌ 3/4 passed · attempt 1
| | Criterion | Evidence |
|---|---|---|
| ✅ | C1 SAVE10 adds a "SAVE10 −$5.00" discount line | ▶ [{c1_from}–{c1_to}]({report}#C1) |
| ❌ | C2 The total drops 10% to $45.00 right away, with no refresh | ![C2]({c2_gif}) |
| | Expected $50.00 → $45.00 within 1 s. Readings: +0 s $50.00 · +1 s $50.00 · +3 s $50.00 · after reload $45.00 | |
| ✅ | C3 The expired code OLD5 shows "This code has expired" | ▶ [{c3_from}–{c3_to}]({report}#C3) |
| ✅ | C4 The savings chart shows the discount slice | ▶ [{c4_from}–{c4_to}]({report}#C4) |
⚠️ Unrequested change on /cart: link "Checkout" → "Continue"
Baseline: main@{base_sha} (merge base) · Judges: Spark Open + Spark 1.3 (agreement required)
<details>🧪 Suggested Playwright tests ({test_count})</details>
⏱ {elapsed} · 💲 {cost}
