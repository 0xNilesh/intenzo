import { readFileSync } from "node:fs";

import { asArray, asString, dig } from "../lib/json.ts";

// Meta Model API (dev.meta.ai/docs): OpenAI-style Chat Completions and Responses endpoints.
export const META_BASE = "https://api.meta.ai/v1";

export const bearer = (key: string): Record<string, string> => ({ Authorization: `Bearer ${key}` });

/** Text of a Chat Completions response. */
export const chatText = (body: unknown): string =>
  asString(dig(body, "choices", 0, "message", "content"));

/** Text of a Responses API response: `output_text` if present, else all output text parts. */
export function responsesText(body: unknown): string {
  const direct = dig(body, "output_text");
  if (typeof direct === "string" && direct !== "") return direct;
  return asArray(dig(body, "output"))
    .flatMap((item) => asArray(dig(item, "content")).map((part) => asString(dig(part, "text"))))
    .join("");
}

/** A local file as a base64 data URL, the inline form both APIs accept for images and video. */
export const dataUrl = (path: string, mime: string): string =>
  `data:${mime};base64,${readFileSync(path).toString("base64")}`;
