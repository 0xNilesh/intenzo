// Records the demo ticket's PM screen recording (ROADMAP T0.7, ARCHITECTURE §32): a PM on
// demo-shop's cart (main, which has no discount codes yet) says what the ticket wants, pointing
// at each part of the page while talking about it. That pairing is what the intent step reads to
// date each criterion (sourceMediaAt, §18).
//   pnpm demo:pm-video [--url=https://demo-shop-git-main-…vercel.app] [--out=probes/demo/pm-ticket.mp4]
// Narration uses macOS `say` (Samantha) or espeak-ng. The result is an H.264 + AAC MP4 of about
// 40 s, with a browser address bar on top as in a real screen recording. Upload it to the ticket
// by hand: GitHub has no API for issue attachments. Costs nothing.
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import { chromium, type Page } from "playwright";

import { loadDotEnv, REPO_ROOT } from "../probe/lib/env.ts";
import { ffmpeg } from "../probe/lib/media.ts";
import { aliasUrl } from "./lib/ground-truth.ts";

const option = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const origin = option("url") ?? aliasUrl("main");
const out = option("out") ?? `${REPO_ROOT}probes/demo/pm-ticket.mp4`;
const work = `${REPO_ROOT}probes/demo/pm-video-work/`;
const VIEWPORT = { width: 1280, height: 720 };
const CHROME_HEIGHT = 56;
const GAP_S = 0.7;

loadDotEnv();
const bypass = process.env.DEMO_SHOP_BYPASS_SECRET;

/** A visible arrow that follows the mouse: headless recordings have no cursor. */
const CURSOR = `addEventListener("DOMContentLoaded", () => {
  const c = document.createElement("div");
  c.style.cssText = "position:fixed;left:-50px;top:-50px;width:24px;height:24px;pointer-events:none;z-index:2147483647";
  c.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24"><path d="M3 2l7 19 2.6-7.4L20 11z" fill="#111" stroke="#fff" stroke-width="1.5"/></svg>';
  document.body.append(c);
  addEventListener("mousemove", (e) => { c.style.left = e.clientX + "px"; c.style.top = e.clientY + "px"; }, true);
});`;

type Gesture = (page: Page) => Promise<void>;

/** What the PM says, and where they point while saying it. */
const SCRIPT: { text: string; gesture: Gesture }[] = [
  { text: "Hi! This is our cart page.", gesture: (p) => sweep(p, "Cart items") },
  {
    text: "We need discount codes, with a field for the code right here, under the items.",
    gesture: (p) => circleBelow(p, "Cart items"),
  },
  {
    text: "When I apply SAVE10, the order total should drop ten percent right away, with no refresh. So this fifty dollars should become forty-five.",
    gesture: (p) => pointAt(p, "total"),
  },
  {
    text: "The discount should show up as its own line in the summary: SAVE10, minus five dollars.",
    gesture: (p) => pointAt(p, "subtotal", 30),
  },
  {
    text: "OLD5 is expired, so applying it should show: This code has expired.",
    gesture: (p) => circleBelow(p, "Cart items"),
  },
  {
    text: "And the savings chart in the summary should show the discount slice.",
    gesture: (p) => circleAround(p, "savings-chart"),
  },
  { text: "That's it. Thanks!", gesture: (p) => p.mouse.move(640, 600, { steps: 20 }) },
];

rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

// 1. Narration: one clip per line, so each can start when its gesture does.
const clips = SCRIPT.map((line, n) => {
  const file = `${work}line-${n}.aiff`;
  speak(line.text, file);
  return { file, seconds: duration(file) };
});
let at = 1.5;
const starts = clips.map((c) => {
  const start = at;
  at += c.seconds + GAP_S;
  return start;
});

// 2. The screen recording, with a visible cursor (headless recordings have none).
const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    recordVideo: { dir: work, size: VIEWPORT },
    ...(bypass && {
      extraHTTPHeaders: {
        "x-vercel-protection-bypass": bypass,
        "x-vercel-set-bypass-cookie": "true",
      },
    }),
  });
  await context.addInitScript(CURSOR);
  const page = await context.newPage();
  const t0 = Date.now();
  await page.goto(`${origin}/cart`);
  await page.getByTestId("savings-chart").waitFor();
  await page.mouse.move(640, 360);
  for (const [n, line] of SCRIPT.entries()) {
    await sleep(Math.max(0, t0 + starts[n]! * 1000 - Date.now()));
    await line.gesture(page);
  }
  await sleep(Math.max(0, t0 + (at + 0.5) * 1000 - Date.now()));
  await context.close();
  const recording = readdirSync(work).find((f) => f.endsWith(".webm"))!;
  renameSync(`${work}${recording}`, `${work}screen.webm`);

  // 3. The address bar, drawn by Chromium (Homebrew's ffmpeg has no drawtext).
  const bar = await browser.newPage({ viewport: { width: VIEWPORT.width, height: CHROME_HEIGHT } });
  await bar.setContent(addressBar(`${new URL(origin).host}/cart`));
  await bar.screenshot({ path: `${work}bar.png` });
} finally {
  await browser.close();
}

// 4. Narration track, then bar + screen + narration → MP4.
const delays = clips
  .map((_, n) => `[${n}:a]adelay=${Math.round(starts[n]! * 1000)}:all=1[a${n}]`)
  .join(";");
const mix = `${clips.map((_, n) => `[a${n}]`).join("")}amix=inputs=${clips.length}:normalize=0[out]`;
// prettier-ignore
ffmpeg(...clips.flatMap((c) => ["-i", c.file]), "-filter_complex", `${delays};${mix}`, "-map", "[out]", "-ar", "44100", `${work}narration.wav`);
mkdirSync(out.slice(0, out.lastIndexOf("/") + 1), { recursive: true });
// prettier-ignore
ffmpeg("-i", `${work}screen.webm`, "-loop", "1", "-i", `${work}bar.png`, "-i", `${work}narration.wav`,
  "-filter_complex", "[1:v][0:v]vstack=inputs=2:shortest=1,format=yuv420p[v];[2:a]apad[a]",
  "-map", "[v]", "-map", "[a]", "-shortest", "-c:v", "libx264", "-c:a", "aac", "-movflags", "+faststart", out);
rmSync(work, { recursive: true, force: true });
console.log(`Wrote ${out.replace(REPO_ROOT, "")} (${duration(out).toFixed(1)} s). Narration:`);
for (const [n, line] of SCRIPT.entries()) console.log(`  ${starts[n]!.toFixed(1)} s  ${line.text}`);

function speak(text: string, file: string): void {
  try {
    execFileSync("say", ["-v", "Samantha", "-o", file, text]);
  } catch {
    execFileSync("espeak-ng", ["-w", file, text]);
  }
}

function duration(file: string): number {
  // prettier-ignore
  const s = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
  return Number(String(s).trim());
}

async function box(page: Page, target: string) {
  const el =
    target === "Cart items"
      ? page.getByRole("list", { name: "Cart items" })
      : page.getByTestId(target);
  const b = await el.boundingBox();
  if (!b) throw new Error(`no box for ${target}`);
  return b;
}

async function sweep(page: Page, target: string): Promise<void> {
  const b = await box(page, target);
  await page.mouse.move(b.x + 20, b.y + 10, { steps: 25 });
  await page.mouse.move(b.x + b.width - 20, b.y + b.height - 10, { steps: 40 });
}

async function pointAt(page: Page, target: string, dy = 0): Promise<void> {
  const b = await box(page, target);
  const x = b.x + b.width / 2;
  const y = b.y + b.height / 2 + dy;
  await page.mouse.move(x, y, { steps: 30 });
  for (const d of [8, -8, 8, 0]) await page.mouse.move(x + d, y, { steps: 6 });
}

async function circle(page: Page, cx: number, cy: number, r: number): Promise<void> {
  await page.mouse.move(cx + r, cy, { steps: 25 });
  for (let a = 0; a <= 2 * Math.PI + 0.01; a += Math.PI / 18) {
    await page.mouse.move(cx + r * Math.cos(a), cy + r * Math.sin(a));
    await sleep(25);
  }
}

async function circleBelow(page: Page, target: string): Promise<void> {
  const b = await box(page, target);
  await circle(page, b.x + 160, b.y + b.height + 40, 34);
}

async function circleAround(page: Page, target: string): Promise<void> {
  const b = await box(page, target);
  await circle(page, b.x + b.width / 2, b.y + b.height / 2, b.width / 2 - 6);
}

function addressBar(url: string): string {
  const dot = (color: string) =>
    `<span style="width:12px;height:12px;border-radius:50%;background:${color};display:inline-block"></span>`;
  return `<body style="margin:0"><div style="height:${CHROME_HEIGHT}px;background:#e5e7eb;display:flex;align-items:center;gap:8px;padding:0 16px;font:15px system-ui,Arial,sans-serif;border-bottom:1px solid #d1d5db">
${dot("#ef4444")}${dot("#f59e0b")}${dot("#22c55e")}
<div style="margin-left:18px;flex:1;height:34px;border-radius:17px;background:#fff;display:flex;align-items:center;padding:0 16px;color:#374151">🔒&nbsp; ${url}</div></div></body>`;
}
