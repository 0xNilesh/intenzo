import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { isMap, LineCounter, parseDocument, type Document } from "yaml";
import type { z } from "zod";

import { IntenzoConfig } from "../schema/config.ts";

// Reads a repo's .intenzo.yml (ARCHITECTURE §10). Problems are reported as setup errors on the PR,
// so each one names the key and, when it can, the line.

export const CONFIG_FILENAMES = [".intenzo.yml", ".intenzo.yaml"] as const;

export interface ConfigProblem {
  /** Dotted path to the offending key ("policy.auto_merge"); "" for the file as a whole. */
  path: string;
  message: string;
  /** 1-based line in the file, when known. */
  line?: number;
}

export type ConfigResult =
  { ok: true; config: IntenzoConfig } | { ok: false; problems: ConfigProblem[] };

/** Parses and validates .intenzo.yml text. Never throws. */
export function parseConfig(text: string): ConfigResult {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, uniqueKeys: true });
  if (doc.errors.length > 0) {
    return {
      ok: false,
      problems: doc.errors.map((e) => ({
        path: "",
        message: (e.message.split("\n")[0] ?? e.message).replace(/:$/, ""),
        ...(e.linePos?.[0] && { line: e.linePos[0].line }),
      })),
    };
  }

  const data: unknown = doc.toJS() ?? {};
  if (typeof data !== "object" || Array.isArray(data)) {
    return {
      ok: false,
      problems: [{ path: "", message: "must be a mapping of settings (key: value)", line: 1 }],
    };
  }

  const result = IntenzoConfig.safeParse(data);
  if (result.success) return { ok: true, config: result.data };
  return {
    ok: false,
    problems: result.error.issues.flatMap((i) => toProblems(i, doc, lineCounter)),
  };
}

/**
 * Reads the config from a repo checkout. With no config file, Intenzo runs on the defaults; two
 * config files are a problem, since it's unclear which one is meant.
 */
export function readConfig(repoDir: string): { file: string | null; result: ConfigResult } {
  // The ignore comments keep Next.js from tracing the whole project into the Cloud's functions:
  // the Cloud bundles this module (for configFromFiles) but never reads a checkout.
  const path = (name: string) => join(/*turbopackIgnore: true*/ repoDir, name);
  return configFromFiles(
    CONFIG_FILENAMES.filter((name) => existsSync(/*turbopackIgnore: true*/ path(name))).map(
      (name) => ({ name, text: readFileSync(/*turbopackIgnore: true*/ path(name), "utf8") }),
    ),
  );
}

/**
 * The config from the config files a repo has, however they were read (a checkout, or GitHub's
 * contents API in the Cloud): none → the defaults, one → parsed, two → a problem.
 */
export function configFromFiles(files: readonly { name: string; text: string }[]): {
  file: string | null;
  result: ConfigResult;
} {
  if (files.length > 1) {
    const names = files.map((f) => f.name).join(" and ");
    return {
      file: null,
      result: { ok: false, problems: [{ path: "", message: `found both ${names}; keep one` }] },
    };
  }
  const [found] = files;
  if (!found)
    return { file: null, result: { ok: true, config: IntenzoConfig.parse({ version: 1 }) } };
  return { file: found.name, result: parseConfig(found.text) };
}

/** Renders problems for a PR comment or the CLI: "line 3: policy.auto_merge: unknown key". */
export function formatProblems(file: string, problems: readonly ConfigProblem[]): string {
  return problems
    .map((p) => `${file}${p.line ? `:${p.line}` : ""}: ${p.path ? `${p.path}: ` : ""}${p.message}`)
    .join("\n");
}

type Issue = z.ZodError["issues"][number];
type Path = readonly PropertyKey[];

function toProblems(issue: Issue, doc: Document, lc: LineCounter): ConfigProblem[] {
  if (issue.code === "unrecognized_keys") {
    return issue.keys.map((key) => {
      const line = keyLine(doc, lc, issue.path, key);
      return {
        path: [...issue.path, key].join("."),
        message: "unknown key",
        ...(line && { line }),
      };
    });
  }
  const line = valueLine(doc, lc, issue.path);
  return [{ path: issue.path.join("."), message: issue.message, ...(line && { line }) }];
}

function keyLine(doc: Document, lc: LineCounter, parent: Path, key: string): number | undefined {
  const node = parent.length === 0 ? doc.contents : doc.getIn(parent as unknown[], true);
  if (!isMap(node)) return undefined;
  const pair = node.items.find((p) => (p.key as { value?: unknown } | null)?.value === key);
  const start = (pair?.key as { range?: [number, number, number] } | null)?.range?.[0];
  return start === undefined ? undefined : lc.linePos(start).line;
}

/** The line of the value at `path`, or of its nearest ancestor that exists in the file. */
function valueLine(doc: Document, lc: LineCounter, path: Path): number | undefined {
  for (let depth = path.length; depth > 0; depth--) {
    const node = doc.getIn(path.slice(0, depth) as unknown[], true) as
      { range?: [number, number, number] } | undefined;
    if (node?.range) return lc.linePos(node.range[0]).line;
  }
  return undefined;
}
