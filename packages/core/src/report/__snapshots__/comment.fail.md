<!-- intenzo:run-group:2 -->
### Intenzo · verified against #5 "Discount codes" · ❌ 3/4 passed · attempt 1

| | Criterion | Evidence |
|---|---|---|
| ✅ | **C1** SAVE10 takes 10% off the cart | [▶ 0:04–0:08](https://intenzo-cloud.vercel.app/r/4f4cf15f-0000-4000-8000-000000000001#C1) |
| ❌ | **C2** The total drops 10% to $45.00 right away, with no refresh | [▶ 0:04–0:08](https://intenzo-cloud.vercel.app/r/4f4cf15f-0000-4000-8000-000000000001#C2) |
| | Expected: The order total changes from $50.00 to $45.00 within 1 s of applying SAVE10 · Observed: The total stayed $50.00 after Apply and only changed after a reload. | |
| ✅ | **C3** An expired code shows a clear message | [▶ 0:04–0:08](https://intenzo-cloud.vercel.app/r/4f4cf15f-0000-4000-8000-000000000001#C3) |
| ✅ | **C4** The savings chart shows the 10% slice | [▶ 0:04–0:08](https://intenzo-cloud.vercel.app/r/4f4cf15f-0000-4000-8000-000000000001#C4) |

Baseline: `b6b60c7` (the merge base) · Judges: Spark Open + Spark 1.3

⏱ 1 m 52 s · 💲 $0.31 · [Full report](https://intenzo-cloud.vercel.app/r/4f4cf15f-0000-4000-8000-000000000001)

<details><summary>Readings</summary>

- **C2** +0 s $50.00 · +1 s $50.00 · +3 s $50.00 · after reload $45.00
</details>

<details><summary>Earlier runs (1)</summary>

- `af1065e` attempt 1: superseded
</details>
