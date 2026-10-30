import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { metaKey } from "../lib/env.ts";
import { parseJson, pickLimits, request } from "../lib/http.ts";
import { asArray, asString, dig } from "../lib/json.ts";
import { capability, failed, missingKey, quote, type Probe } from "../lib/probe.ts";
import { REQUIRED } from "../lib/results.ts";
import { shapeOf } from "../lib/shape.ts";
import { latency } from "../lib/stats.ts";
import { META_BASE, bearer } from "./meta-api.ts";

// Muse Code is a product, not a Model API model id (dev.meta.ai/docs/models): the `muse` CLI, plus
// @muse-code/sdk, which drives a CLI session. Headless runs are `muse exec --json` with
// META_API_KEY in the environment (docs/muse-code/extending, /auth). On Linux its sandbox needs
// bubblewrap, which matters for muse-fixer on GitHub Actions (T5.3).
const INSTALL = "curl -fsSL https://dev.meta.ai/install.sh | sh";
const TASK =
  "Create a file named probe.txt in the current directory containing exactly the text OK. " +
  "Do nothing else.";
const ARGS = ["exec", "--json", "--max-model-steps", "6", "--disable-approval", TASK];

export const probeMuseCode: Probe = async (ctx) => {
  const key = metaKey();
  if (!key) return missingKey(ctx, "muse-code", REQUIRED["muse-code"], "META_API_KEY");

  await capability(ctx, "muse-code", "api_model", async () => {
    const res = await request(`${META_BASE}/models`, { headers: bearer(key) });
    if (!res.ok) return failed(res);
    const ids = asArray(dig(res.body, "data")).map((m) => asString(dig(m, "id")));
    const codeIds = ids.filter((id) => /code/i.test(id));
    return {
      status: codeIds.length > 0 ? "ok" : "unsupported",
      latencyMs: latency([res.ms]),
      correct: null,
      response: shapeOf(res.body),
      limits: pickLimits(res.headers),
      notes:
        codeIds.length > 0
          ? `model ids mentioning code: ${codeIds.join(", ")}`
          : `no Muse Code model id; the Model API lists ${ids.join(", ")}. Muse Code = the muse CLI (+ SDK)`,
    };
  });

  await capability(ctx, "muse-code", "cli_headless", async () => {
    const version = spawnSync("muse", ["--version"], { encoding: "utf8" });
    if (version.error) {
      return {
        status: "error",
        latencyMs: null,
        correct: null,
        error: `muse CLI is not installed (install: ${INSTALL}), so headless use can't be checked`,
      };
    }
    // A throwaway folder: the agent may only touch this directory.
    const dir = mkdtempSync(join(tmpdir(), "intenzo-muse-probe-"));
    try {
      const started = performance.now();
      const run = spawnSync("muse", ARGS, {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, META_API_KEY: key },
        timeout: 300_000,
        maxBuffer: 32 * 1024 * 1024,
      });
      const ms = performance.now() - started;
      const events = run.stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => parseJson(line));
      const types = [
        ...new Set(
          events
            .map((e) => asString(dig(e, "payload_type")) || asString(dig(e, "type")))
            .filter(Boolean),
        ),
      ];
      const file = join(dir, "probe.txt");
      const wrote = existsSync(file) ? readFileSync(file, "utf8").trim() : null;
      const notes = [
        `muse ${version.stdout.trim()}`,
        `exit ${run.status ?? run.signal}`,
        `${events.length} JSONL events (payload types: ${types.join(", ") || "none"})`,
        wrote === null ? "probe.txt not created" : `probe.txt = ${quote(wrote)}`,
        "Linux sandbox needs bubblewrap (docs)",
      ].join("; ");
      if (run.status !== 0) {
        return {
          status: "error",
          latencyMs: latency([ms]),
          correct: null,
          error: `muse exec exited ${run.status ?? run.signal}: ${run.stderr.trim().slice(-300)}`,
          notes,
        };
      }
      return {
        status: "ok",
        latencyMs: latency([ms]),
        correct: wrote === "OK",
        request: { command: `muse ${ARGS.slice(0, -1).join(" ")} <task>`, env: "META_API_KEY" },
        response: shapeOf(events.slice(0, 3)),
        notes,
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
};
