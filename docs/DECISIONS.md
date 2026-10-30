# Decisions

Choices made while building Intenzo, with the evidence behind them. Newest first. Each entry gives
the date, the decision, why, and the alternatives considered (CONTRIBUTING.md §8).

---

## 2026-10-30 · Judge go/no-go: GO (T0.3, #4)

Measured with `pnpm gonogo` (see `scripts/gonogo/README.md`):

- **Clips:** 10, recorded with Playwright from a local fixture shop whose planted behaviors are proven by browser tests. 4 correct, 4 almost-right (stale total, off by a cent, wrong %, missing error) and 2 ambiguous ("clear confirmation", "updates quickly").
- **Bundle:** both judges get the same `judge.v1` input: the criterion, the step log with Tt, the readings, the annotated Tt+1000 still, and the 4 fps judge clip.
- **Rule:** §22.3 decides.
- **Takes:** one per clip, no baseline.

The run was done twice: at each model's default reasoning effort, and with `reasoning_effort: "low"`. That makes 40 calls, with no retries and no parse failures. Raw answers are in `probes/gonogo/` (gitignored).

### What we found

| Effort | Accuracy (decided) | False fails | False passes | Inconclusive (clear) | Verdict p50 / max | Spark Open p50 / max | Spark 1.3 p50 / max | Cost per criterion |
|---|---|---|---|---|---|---|---|---|
| default | 8/8 = 100% | 0 | 0 | 0/8 | 10.1 / 33.1 s | 6.4 / 11.7 s | 10.1 / 33.1 s | $0.020 |
| `low` | 8/8 = 100% | 0 | 0 | 0/8 | 6.4 / 9.4 s | 3.1 / 4.1 s | 6.4 / 9.4 s | $0.013 |

- **Each judge alone** was also 8/8 at both efforts.
- **Citations:** every pass and fail cited a reading whose value matched (`valueMatches`), with 0 wrong targets. The R13 what-if therefore changes nothing.
- **Missing error:** both judges cited the live-region diff value `no change`. An `absent` reading has no value to cite, so this is how the §22.3 rule handles a missing element.
- **Ambiguous clips:** both judges passed both, at both efforts, and agreed with each other:
  - "updates quickly" was judged at Tt+3000, the prompt's rule when there's no `timingMs`.
  - A grey "Applied" button counted as a clear confirmation.
- **Output format:** Spark Open on Baseten, which has no structured outputs, returned a valid `JudgeOutput` from the prompt alone 20/20 times. Spark 1.3 accepted the strict `json_schema` with `anyOf` nullables.
- **Latency:** Spark 1.3's default effort is the outlier. The stale-total clip took 4,132 reasoning tokens and 33 s; at `low`, 819 tokens and 8.8 s.
- **ffmpeg:** Homebrew's ffmpeg 8.1.1 has no `drawtext` (it's built without freetype). The judge clip's time band and the labels are drawn with Chromium.
- **Spend:** $0.328 in total. $0.139 was Baseten (Spark Open), at list price ($1.25 / $0.15 / $4.25 per million input / cached / output tokens), out of about $1 of Baseten credit. The other $0.189 was Meta (Spark 1.3).

### Decisions

1. **GO. The two judges and the strict §22.3 rule stay as designed; R13 isn't needed.**
   - *Why:* every GO threshold holds with room to spare at both efforts: 100% accuracy (need ≥ 80%), 0 false fails, 0% inconclusive (need ≤ 30%), slowest verdict 33 s (need < 60 s).
   - *Caveat:* small n. These are 10 clips on one simple page, and they were easy for both models. IntentBench (P6) is the real measure, including the false-pass rate (R12).
2. **Both judges run with `reasoning_effort: "low"`.**
   - *Why:* accuracy is the same (8/8), the slowest verdict drops from 33.1 s to 9.4 s, and cost per criterion drops 38% ($0.020 → $0.013). Spark Open, on scarce Baseten credits, costs 47% less.
   - *Alternatives:* the default effort gained nothing here. Revisit if IntentBench shows misses on harder cases, where more reasoning might help.
   - *Next:* T4.6 puts the effort in the model registry, and T6.3 can report both levels.
3. **The intent step must make vague criteria concrete, because the judges don't hedge.**
   - *Why:* the two ambiguous clips came back as an agreed pass, not inconclusive. The agreement rule catches disagreement, not shared interpretation (R12).
   - *Next:* T4.1 turns vague timing words ("quickly", "right away") into a `timingMs`, as §7 already does for "instantly" → 1000. It marks subjective words ("clear", "nice") as `inferred` or raises them as a question for the PM.
4. **An empty live-region diff reads `no change`; keep it (T1.5).**
   - *Why:* it's the citable value for "nothing appeared", which keeps missing-element bugs decided instead of inconclusive. ARCHITECTURE §22.3 now says so.
5. **Overlays never cover the page, and text isn't drawn with ffmpeg's `drawtext`.**
   - *Why:* a timestamp in the top-right corner covered the toast area, and Homebrew's ffmpeg has no `drawtext`.
   - *Decision:* the judge clip carries the time in a 40 px band under the frame (960×580), and the annotation labels sit in a column beside the screenshot.
   - *Next:* T1.4 and T1.7 follow this, and §21.4 is updated.
6. **Spark Open is asked for JSON by prompt; Spark 1.3 uses a strict `json_schema`.**
   - *Why:* Baseten's docs say "All except Muse Spark Open support structured outputs and JSON mode". §14's "JSON mode if supported" covers this; it's recorded so T4.6 doesn't expect structured output from Baseten.

---

## 2026-10-30 · Spark Open on Baseten (T0.2b, #64)

Measured with `pnpm probe:all spark-open` (one call per check) against Baseten Model APIs, using the
same ground-truth media as T0.2. With this, `pnpm probe:assert` passes for all six models (22 checks).

| Check | Result | p50 | Notes |
|---|---|---|---|
| models_list | ok | 2.2 s | `meta-models/muse-spark-open` (1 match among 20 models); no `-1026` id exists |
| text | ok, correct | 1.7 s | first call 1.3 s: no cold start on the shared Model API |
| image | ok, correct | 3.0 s | "50.00" |
| video (native MP4, `video_url`) | ok, correct | 2.8 s | "start=$50.00, end=$45.00"; 946 prompt / 560 output tokens |
| frames (5 timestamped stills) | ok, correct | 5.3 s | same answer; 3,460 prompt tokens |

Cost: about $0.016 of Baseten credits for the run.

### Decisions

1. **Spark Open judges native video, the same inline MP4 Spark 1.3 gets (R2 resolved).**
   - *Why:* It read the clip correctly via `video_url`. Frames mode was also right, but slower (5.3 s vs 2.8 s) and 3.7× the prompt tokens.
   - *Alternatives:* Frames mode stays as the fallback in `MediaEncoder` (§14) if a clip is ever rejected.
2. **The two judges are Spark Open (A) + Spark 1.3 (B), as designed.**
   - *Why:* Both read the judge clip correctly. This supersedes the 2026-10-30 T0.2 entry's item 6 (wait for credits); Wonder stays a tested fallback, not needed now.
3. **Use the discovered model id `meta-models/muse-spark-open` on Baseten Model APIs; no pre-warming.**
   - *Why:* The hackathon guide's `-1026` id isn't served. The first call took 1.3 s, so there's no cold start to pre-warm on the shared Model API (ARCHITECTURE §3 and T7.2 updated).

---

## 2026-10-30 · Model capabilities from the T0.2 probes (#3)

Measured with `pnpm probe:all` against the live APIs, one call per check unless noted. Raw results
are in `probes/results.json` (local and gitignored); see `scripts/probe/README.md` to reproduce.
The probe media has known answers (the total changes from $50 to $45 at 2.5 s, a red box and an
Apply button at fixed pixels, speech saying "forty five"), so "correct" means the model got the
fact right, not just that it replied.

### What the probes found

| Model | Check | Result | p50 | Notes |
|---|---|---|---|---|
| Spark 1.3 | text | ok, correct | 2.1 s | 5 calls |
| | json_schema (strict) | ok, correct | 2.9 s | 5 calls; `{"total":45}` |
| | image (data URL) | ok, correct | 2.7 s | 5 calls |
| | video_inline (MP4 data URL) | ok, correct | 2.9 s | 5 calls; 5 s clip = 1,349 prompt tokens, 1,251 cached on repeat |
| | video_file (Files API) | ok, correct | 5.5 s | 5 calls; `input_video` + `file_id` accepted; upload 2.7 s |
| | computer_use | ok, correct | 5.6 s | 2 turns: screenshot, then a click inside the Apply button |
| Wonder | text | ok, correct | 1.8 s | |
| | video_inline (MP4 data URL) | ok, correct | 4.6 s | same clip and question as Spark; 801 in / 350 out tokens, about $0.01 |
| | computer_use | **unsupported** | n/a | `HTTP 400: Unsupported tool type: 'computer'` |
| SAM 3.1 | image_text ("red rectangle") | ok, correct | 2.4 s | IoU ≥ 0.7, confidence 0.93, lossless mask 120×200 |
| | video_text / video_box / video_point | ok, correct | 5.1 / 6.4 / 7.3 s | 50 of 50 frames tracked (IoU ≥ 0.7); first frame streams after 2–4 s |
| Voice Transcribe | file (WAV) | ok, correct | 2.7 s | "apply the code SAVE10 and the order total should drop to $45."; `turns` empty |
| | realtime (WebSocket) | ok, correct | 0.35 s | endStream → final transcript; events: `audioProgress`, `transcript` |
| Muse Code | api_model | **unsupported** | n/a | no model id; the Model API lists Spark 1.1–1.3 (+ contributor), Wonder, SAM 3.1, Image, Transcribe |
| | cli_headless | ok, correct | 24 s | `muse exec --json` (1.4.14, macOS) wrote `probe.txt = OK`, exit 0; JSONL records carry `payload_type` (e.g. `runtime.command.accepted`) |
| Spark Open | all 5 checks | pending | | waiting for Baseten or Fireworks credits (both requested) |

Rate limits match the docs: `x-ratelimit-limit-requests: 3000`, `x-ratelimit-limit-tokens: 4000000`.

### Decisions

1. **Judge video goes inline as an MP4 data URL (`video_url`, Chat Completions).**
   - *Why:* Spark 1.3 read the 5 s clip correctly at 2.9 s p50 with no upload step, and repeats hit the prompt cache.
   - *Alternatives:* The Files API path also works (`input_video` + `file_id`), but costs a 2.7 s upload and 5.5 s per call. Keep it for clips too large to inline; the size limit is unpublished, so measure it in T0.3. Frames mode (ARCHITECTURE §14) is no longer needed for Spark 1.3; it stays as the Spark Open fallback (R2).
2. **The vision fallback (§20.5) runs on Spark 1.3 computer use, not Wonder.**
   - *Why:* The live API rejects the documented `{"type":"computer"}` tool for `muse-wonder-1.0` but accepts it for `muse-spark-1.3`, which clicked inside the target in 2 turns. The docs also say Spark runs this loop more cheaply.
   - *Alternatives:* Wait for Wonder support (re-probe before P3), or have Wonder pick coordinates from a screenshot in plain text (no tool). Wonder stays the text-outline navigator; its text calls work.
3. **SAM 3.1 is the evidence model, as designed (§23).**
   - *Why:* Concept, box and point prompts all tracked the target in every frame, with confidence scores and lossless masks, in 5–7 s per 50-frame call.
   - *Alternatives:* DOM box tracks only (no model). They stay the cheap path for DOM targets.
   - *Budget:* each video call bills at least 50 frames ($0.01).
4. **Spoken intent uses the file transcription endpoint. Timestamps (`sourceMediaAt`) come from Spark watching the PM video.**
   - *Why:* Both modes transcribe accurately, but neither returns word or turn timings: `turns` is empty in `PUSH_TO_TALK`, and the realtime stream sends only `audioProgress` and `transcript` events. The file endpoint is simpler and needs no real-time pacing.
   - *Alternatives:* Realtime for live notes (0.35 s to finalize); `DIARIZATION` mode, untested.
5. **Muse Code runs in muse-fixer as a headless CLI; the coverage check uses Spark 1.3.**
   - *Why:* The Model API lists no Muse Code model (it's a product), but `muse exec --json` completed a file-writing task headless in 24 s with `META_API_KEY` alone. That takes the "CLI only" branch of the ARCHITECTURE §4 decision tree: Muse Code works where a repo checkout exists (muse-fixer: the fix and a proposed test), and coverage moves to Spark 1.3. The worker never gets a checkout.
   - *Next:* T5.3 checks the CLI on a Linux Actions runner (the docs say its sandbox needs bubblewrap) and parses the `payload_type` JSONL stream.
6. **Spark Open stays the primary judge; we wait for its credits.**
   - *Why:* It's the design (open weights, self-hostable, the Best Open Weight angle), and the credits are requested from both Baseten and Fireworks. The probe already takes either host (`SPARK_OPEN_BASE_URL` + `SPARK_OPEN_API_KEY`).
   - *Fallback, not adopted:* Wonder read the judge clip correctly (4.6 s, about $0.01 a call). If no Spark Open host exists by P4, the two judges can be Spark 1.3 + Wonder (different models, same Meta key) until it does.
7. **Probe frugally, and watch reasoning tokens.**
   - *Why:* On the video question, 1,227 of Spark's 1,247 output tokens were reasoning. Spark at 5 calls per check (25 calls) cost about $0.09. Probes now default to one call per check (`PROBE_SAMPLES` raises it).
   - *Next:* T0.3 should test a lower reasoning effort for the judge if accuracy holds.

### Moved to T0.2b (#64)
- `spark-open/*` (5 checks): done; see the T0.2b entry above.
