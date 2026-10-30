# Decisions

Choices made while building Intenzo, with the evidence behind them. Newest first. Each entry gives
the date, the decision, why, and the alternatives considered (CONTRIBUTING.md §8).

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
- `spark-open/*` (5 checks): waiting for Baseten or Fireworks credits. Then add the key to `.env` and run `pnpm probe:all spark-open`.
