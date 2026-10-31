import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { extractIntent, INTENT_MODEL, type TicketText } from "@intenzo/core/intent";
import { costUsd, metaModelPort } from "@intenzo/core/models";

import { REPO, UsageError } from "./record.ts";

// `intenzo intent`: reads a text ticket with Spark 1.3 (intent.v1, ARCHITECTURE §18) and prints
// the criteria it yields. One call, two when the reply breaks the checklist rule: about a cent.
//
//   pnpm intenzo intent --ticket fixtures/tickets/42.md [--model <id>] [--out <CriterionSet.json>]

export const INTENT_USAGE = `Usage: pnpm intenzo intent --ticket <ticket.md> [--model <id>] [--out <file.json>]

  --ticket  a markdown ticket: its first "# " line is the title, the rest the body
  --model   the intent model (default: ${INTENT_MODEL})
  --out     also write the CriterionSet as JSON
  One or two Spark 1.3 calls; needs META_API_KEY in .env.`;

export interface IntentArgs {
  ticket: string;
  model: string;
  out?: string;
}

export function parseIntentArgs(argv: readonly string[]): IntentArgs {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        ticket: { type: "string" },
        model: { type: "string" },
        out: { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  if (!values.ticket) throw new UsageError("--ticket is required");
  return {
    ticket: values.ticket,
    model: values.model ?? INTENT_MODEL,
    ...(values.out && { out: values.out }),
  };
}

/** A markdown ticket: the first "# " line is its title, everything after it the body. */
export function readTicketFile(text: string, ref: string): TicketText {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const at = lines.findIndex((l) => /^#\s+\S/.test(l));
  const title = at >= 0 ? lines[at]!.replace(/^#\s+/, "").trim() : "";
  const body = (at >= 0 ? lines.slice(at + 1) : lines).join("\n").trim();
  return { ref, title, body, comments: [] };
}

export async function runIntent(argv: readonly string[]): Promise<number> {
  const args = parseIntentArgs(argv);
  const cwd = process.env.INIT_CWD ?? process.cwd(); // where the user ran pnpm
  if (existsSync(join(REPO, ".env"))) process.loadEnvFile(join(REPO, ".env"));
  const apiKey = process.env.META_API_KEY ?? process.env.MODEL_API_KEY;
  if (!apiKey) throw new UsageError("META_API_KEY isn't set (add it to .env)");

  const file = resolve(cwd, args.ticket);
  if (!existsSync(file)) throw new UsageError(`no ticket at ${args.ticket}`);
  const ticket = readTicketFile(readFileSync(file, "utf8"), `#${basename(file, ".md")}`);
  console.log(`intenzo intent · ${args.ticket} · "${ticket.title}" · ${args.model}`);

  const result = await extractIntent(metaModelPort({ apiKey }), ticket, { model: args.model });
  for (const c of result.intent.criteria) {
    console.log(`\n${c.id} [${c.kind}${c.inferred ? ", inferred" : ""}] ${c.text}`);
    console.log(`   trigger:  ${c.trigger || "(none)"}`);
    if (c.setup.length) console.log(`   setup:    ${c.setup.join("; ")}`);
    console.log(`   expected: ${c.expected}`);
    const extras = [
      c.watch.length ? `watch ${c.watch.join(", ")}` : "",
      c.timingMs ? `within ${c.timingMs} ms` : "",
      c.persistence ? "survives a reload" : "",
    ].filter(Boolean);
    if (extras.length) console.log(`   ${extras.join(" · ")}`);
    if (c.sourceQuote) console.log(`   from:     "${c.sourceQuote}"`);
  }
  const { repro } = result.intent;
  if (repro)
    console.log(
      `\nrepro: start ${repro.startPath ?? "?"}${repro.steps.length ? `, ${repro.steps.join(" → ")}` : ""}`,
    );
  for (const p of result.problems) console.log(`\n✗ ${p}`);
  const cost = costUsd(args.model, result.usage);
  console.log(
    `\n${result.intent.criteria.length} criteria · ${result.calls} call(s) · ${result.usage.promptTokens} in / ${result.usage.completionTokens} out (${result.usage.reasoningTokens} reasoning) tokens · ${cost === null ? "cost unknown" : `$${cost.toFixed(4)}`}`,
  );
  console.log(`ticket hash ${result.intent.ticketHash}`);
  if (args.out) {
    const out = resolve(cwd, args.out);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(result.intent, null, 2)}\n`);
    console.log(`wrote ${args.out}`);
  }
  return result.ok ? 0 : 1;
}
