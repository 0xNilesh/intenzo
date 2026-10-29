export interface SseEvent {
  event: string;
  data: string;
}

/** Parses one server-sent-events block (the lines between two blank lines). */
export function parseSseBlock(block: string): SseEvent | null {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  return data.length > 0 || event !== "message" ? { event, data: data.join("\n") } : null;
}

export function parseSse(text: string): SseEvent[] {
  return text
    .split(/\r?\n\r?\n/)
    .map(parseSseBlock)
    .filter((e): e is SseEvent => e !== null);
}

/** Yields events from a streaming response body as they complete, across chunk boundaries. */
export async function* readSse(body: AsyncIterable<Uint8Array>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary: RegExpExecArray | null;
    while ((boundary = /\r?\n\r?\n/.exec(buffer)) !== null) {
      const event = parseSseBlock(buffer.slice(0, boundary.index));
      buffer = buffer.slice(boundary.index + boundary[0].length);
      if (event) yield event;
    }
  }
  buffer += decoder.decode();
  const last = parseSseBlock(buffer);
  if (last) yield last;
}
