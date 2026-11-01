# Intenzo

**Proof your PR did what the ticket asked, on video, before a human opens the diff.**

Intenzo drives a pull request's preview deployment in a real browser, records each acceptance criterion from the linked ticket, judges the recording against that intent with Meta's video models, and posts the verdicts and evidence back to the PR.

- Architecture: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- Build roadmap: [`docs/ROADMAP.md`](docs/ROADMAP.md)
- Contributing (humans and AI agents): [`CONTRIBUTING.md`](CONTRIBUTING.md)
- Operating manual for AI coding agents: [`AGENTS.md`](AGENTS.md)

Built for the Meta Global AI Developer Hackathon (Indie track, _Push the Frontier_).

## IntentBench: what the evidence buys

IntentBench (§31) asks whether watching the app matters, or whether reading the diff is enough. Twelve demo-shop branches implement four tickets correctly, almost right (a planted defect), with an unrequested side effect, or broken. Every one of their 42 criteria has a label proven by a scripted Playwright check. Each criterion is recorded once (`pnpm bench:record`), then judged by four arms that see more and more of the evidence (`pnpm bench:judge`):

| Arm | Sees                                       | Right (judgeable) | Wrong passes                | False fails | Cost / PR |
| --- | ------------------------------------------ | ----------------- | --------------------------- | ----------- | --------- |
| A   | the ticket and the diff only               | 100%              | **33%** of failing criteria | 0%          | $0.017    |
| B   | the recording's readings (text)            | 87%               | 0%                          | 0%          | $0.017    |
| C   | readings + 8 stills                        | 96%               | 0%                          | 0%          | $0.035    |
| D   | readings + the video, two judges (Intenzo) | 98% (96–100%)     | 0%                          | 0%          | $0.040    |

**Held out: 8 cases, 28 criteria, 2 repeats.** "Judgeable" leaves out the 5 criteria whose recording failed (a broken build can't be recorded).

- **Reading the diff is enough to spot these defects, but not enough to merge on.** The diff-only arm passed a build whose cart throws on every load in 4 of 6 judgements. Every arm that ran the app stayed inconclusive there, and none passed it.
- **No arm failed a criterion that holds.**
- **Among the arms that watch the app, more evidence is better:** readings 87%, stills 96%, video 98%.
- **The two judges cover each other:** Spark 1.3 alone once passed a planted off-by-one, and the dual rule didn't.

**Small n:** 8 held-out cases on one demo app, seeded by hand. These numbers show the shape of the trade-off, not a general accuracy.

Charts: [`bench/results/rates.png`](bench/results/rates.png) · [`accuracy.png`](bench/results/accuracy.png) · [`cost.png`](bench/results/cost.png). Method and raw results: [`bench/intentbench/README.md`](bench/intentbench/README.md), [`bench/results/judge-heldout.json`](bench/results/judge-heldout.json), DECISIONS 2026-11-01 · IntentBench judged.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
