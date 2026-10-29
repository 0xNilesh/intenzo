// SAM 3.1 output is text: one line per frame, e.g.
//   <0f>0<|box;x1=..;y1=..;x2=..;y2=..;w=..;h=..|><|mask;x=0;y=0;data=H,W,~<base85>|>,1<|box…|>…
// (dev.meta.ai/docs/sam/reading-segmentation). Coordinates are source pixels; x2/y2 are inclusive.

export interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}
export interface SamBox extends Box {
  w: number;
  h: number;
  c?: number;
}
export interface SamMask {
  h: number;
  w: number;
  encoding: "lossless" | "one_bit";
  payloadChars: number;
  c?: number;
}
export interface SamObject {
  id: number;
  box: SamBox;
  mask: SamMask | null;
}
export interface SamFrame {
  frame: number;
  objects: SamObject[];
}

// The base85 mask payload never contains "|", so the first "|>" always closes a token.
const RECORD = /(\d+)<\|box;([^|]*)\|>(?:<\|mask;([^|]*)\|>)?/g;

export function parseSamLine(line: string): SamFrame | null {
  const marker = /^<(\d+)f>/.exec(line.trim());
  if (!marker) return null;
  const objects = [...line.trim().slice(marker[0].length).matchAll(RECORD)].map(
    ([, id, box, mask]) => ({
      id: Number(id),
      box: parseBox(box ?? ""),
      mask: mask === undefined ? null : parseMask(mask),
    }),
  );
  return { frame: Number(marker[1]), objects };
}

export function parseSamOutput(text: string): SamFrame[] {
  return text
    .split("\n")
    .map(parseSamLine)
    .filter((f): f is SamFrame => f !== null);
}

/** Intersection over union of two boxes with inclusive pixel coordinates. */
export function iou(a: Box, b: Box): number {
  const ix = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1) + 1);
  const iy = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1) + 1);
  const area = (r: Box) => (r.x2 - r.x1 + 1) * (r.y2 - r.y1 + 1);
  const inter = ix * iy;
  return inter / (area(a) + area(b) - inter);
}

function fields(s: string): Record<string, string> {
  return Object.fromEntries(
    s
      .split(";")
      .filter((part) => part.includes("="))
      .map((part) => {
        const eq = part.indexOf("=");
        return [part.slice(0, eq), part.slice(eq + 1)];
      }),
  );
}

function parseBox(s: string): SamBox {
  const f = fields(s);
  const n = (key: string) => Number(f[key]);
  const box: SamBox = { x1: n("x1"), y1: n("y1"), x2: n("x2"), y2: n("y2"), w: n("w"), h: n("h") };
  if (f.c !== undefined) box.c = Number(f.c);
  return box;
}

function parseMask(s: string): SamMask {
  const dataAt = s.indexOf("data=");
  if (dataAt === -1) throw new Error(`SAM mask without data: ${s.slice(0, 60)}`);
  const head = fields(s.slice(0, dataAt));
  const data = s.slice(dataAt + "data=".length);
  const dims = /^(\d+),(\d+),([~!])/.exec(data);
  if (!dims) throw new Error(`unparseable SAM mask data: ${data.slice(0, 40)}`);
  const mask: SamMask = {
    h: Number(dims[1]),
    w: Number(dims[2]),
    encoding: dims[3] === "~" ? "lossless" : "one_bit",
    payloadChars: data.length - dims[0].length,
  };
  if (head.c !== undefined) mask.c = Number(head.c);
  return mask;
}
