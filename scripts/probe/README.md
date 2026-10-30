# Model capability probes (ROADMAP T0.2)

These probes find out what each Meta model can actually do through the APIs we'll build on, with
real calls, before any pipeline code depends on it. Each capability gets a definite answer
(`ok` or `unsupported`), a latency p50, the request and response shapes, rate-limit headers, and,
where the answer can be checked, whether the model got it right.

## Run

```bash
cp .env.example .env          # once; fill in META_API_KEY and BASETEN_API_KEY
pnpm probe:all                # every model (or: pnpm probe:all spark-1.3 sam-3.1)
pnpm probe:all spark-1.3 --only=computer_use   # re-run one check without re-billing the rest
pnpm probe:assert             # exits 1 until every capability has a definite answer
```

- Results go to `probes/results.json` (gitignored). Re-running a model replaces only its results.
- One call per capability by default, enough for a definite answer. Set `PROBE_SAMPLES=5` when you need a meaningful latency p50 (SAM video and realtime transcription still cap at 3).
- **Cost:** real, billed calls. A default run across all models costs a few cents. For scale, Spark 1.3 at 5 samples (25 calls) used about 17k input + 15k output tokens, about $0.09. SAM video bills at least 50 frames per call ($0.01).
- **Muse Code:** `cli_headless` needs the `muse` CLI on your PATH. The probe never installs it. Install it yourself with `curl -fsSL https://dev.meta.ai/install.sh | sh`.

## What's probed

| Model                          | Capability                               | How                                                                                                       |
| ------------------------------ | ---------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `spark-1.3` (`muse-spark-1.3`) | `text`, `json_schema`                    | Chat Completions; strict `json_schema` response format                                                    |
|                                | `image`                                  | `image_url` data URL of the cart still → "what total is shown?"                                           |
|                                | `video_inline`                           | `video_url` data URL of the 5 s MP4 → total at start and end                                              |
|                                | `video_file`                             | Files API upload + Responses (`input_video`, else `input_file`)                                           |
|                                | `computer_use`                           | same loop as Wonder's (the docs say Spark runs it more cheaply)                                           |
| `spark-open` (Baseten)         | `models_list`                            | lists models and picks the `muse-spark-open` id                                                           |
|                                | `text`, `image`                          | OpenAI-compatible Chat Completions; first call timed separately                                           |
|                                | `video`                                  | native `video_url`. Whether this works decides the judge mode (R2)                                        |
|                                | `frames`                                 | five timestamped stills: the frames-mode fallback (ARCHITECTURE §14)                                      |
| `wonder` (`muse-wonder-1.0`)   | `text`                                   | Chat Completions                                                                                          |
|                                | `computer_use`                           | Responses + `{type: "computer"}` on the checkout screenshot; does the click land on Apply?                |
| `muse-code`                    | `api_model`                              | is there a Model API model id? (expected: no, it's a product)                                             |
|                                | `cli_headless`                           | `muse exec --json` in a temp dir: does the agent write `probe.txt = OK`?                                  |
| `sam-3.1`                      | `image_text`                             | concept "red rectangle" on the still, scored by IoU against the known box                                 |
|                                | `video_text`, `video_box`, `video_point` | concept, box and point prompts on the 50-frame MP4, IoU checked in every frame                            |
| `voice-transcribe`             | `file`                                   | multipart WAV upload                                                                                      |
|                                | `realtime`                               | WebSocket: handshake, 80 ms PCM frames at real-time pace, `endStream`; p50 = endStream → final transcript |

The probe media (`probes/media/`, generated by ffmpeg) has known ground truth:

- the cart total is $50.00 and changes to $45.00 at 2.5 s
- the red box and the Apply button are at fixed pixels
- the spoken ticket says "forty five dollars"

## Reading results

- `ok` + `answer WRONG`: the capability works, but the model misread the media. That's a quality finding for the judge design, not a missing answer.
- `unsupported`: a 4xx that names the modality or model. Read the stored `error` to confirm it isn't our request's fault.
- `error`: no answer yet (missing key, outage, unexpected failure). Fix the cause and re-run that model.

Record the conclusions in `docs/DECISIONS.md` (judge mode per model, where Muse Code runs, the transcription approach). They feed the P0 gate.
