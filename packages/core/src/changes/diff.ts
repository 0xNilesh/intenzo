// Unrequested-change detection (ARCHITECTURE §24, T5.6): the same route's accessibility snapshot on
// the base app and the PR app, masked of what differs per lane (the ephemeral user, dates, times,
// amounts), diffed line by line. A line diff (longest common subsequence) handles inserted content
// without shifting everything after it, as a pixel diff would.

/** One line of an aria snapshot: its depth (indentation) and its text, trimmed. */
export interface SnapshotLine {
  depth: number;
  text: string;
}

export interface MaskOptions {
  /** The lane's ephemeral users (acquireIdentity's names), masked wherever they appear. */
  users?: readonly string[];
}

const MASKS: [RegExp, string][] = [
  [/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "<email>"],
  [/\b\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?\b/g, "<date>"],
  [/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, "<date>"],
  [/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2},? \d{4}\b/g, "<date>"],
  [/\b\d{1,2}:\d{2}(:\d{2})?( ?[AaPp][Mm])?\b/g, "<time>"],
  // Amounts follow the cart's state, which each lane seeds afresh.
  [/[-−]?[$€£¥]\s?\d[\d,]*(\.\d+)?/g, "<amount>"],
];

/** The snapshot with what differs per lane masked (§24), as lines. */
export function snapshotLines(snapshot: string, options: MaskOptions = {}): SnapshotLine[] {
  return snapshot
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      // Emails first: a user's name may be part of one.
      let text = line.trim().replace(MASKS[0]![0], MASKS[0]![1]);
      for (const user of options.users ?? []) {
        if (user) text = text.split(user).join("<user>");
      }
      for (const [pattern, mask] of MASKS.slice(1)) text = text.replace(pattern, mask);
      return { depth: line.length - line.trimStart().length, text };
    });
}

/** A run of changed lines: removed from the base, added in the PR, or both (a modification). */
export interface Hunk {
  id: string;
  /** The nearest enclosing landmark or named container, e.g. `region "Order summary"`. */
  landmark: string | null;
  removed: SnapshotLine[];
  added: SnapshotLine[];
  /** Where the lines are in each snapshot. */
  baseIndex: number[];
  prIndex: number[];
}

/** Lines in a and b's longest common subsequence, as index pairs in order. */
function commonLines(a: readonly string[], b: readonly string[]): [number, number][] {
  const n = a.length;
  const m = b.length;
  // lengths[i][j]: the LCS of a[i..] and b[j..].
  const lengths = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lengths[i]![j] =
        a[i] === b[j]
          ? lengths[i + 1]![j + 1]! + 1
          : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
    }
  }
  const pairs: [number, number][] = [];
  for (let i = 0, j = 0; i < n && j < m;) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (lengths[i + 1]![j]! >= lengths[i]![j + 1]!) i++;
    else j++;
  }
  return pairs;
}

const LANDMARK =
  /^- (banner|main|navigation|contentinfo|complementary|region|form|dialog|search)\b/;

/** The landmark that encloses line `index`: the nearest shallower line naming one. */
function landmarkOf(lines: readonly SnapshotLine[], index: number): string | null {
  let depth = lines[index]?.depth ?? 0;
  for (let i = index - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (line.depth >= depth) continue;
    depth = line.depth;
    if (LANDMARK.test(line.text)) return line.text.replace(/^- /, "").replace(/:$/, "");
  }
  return null;
}

/** The hunks between two masked snapshots of one route. */
export function diffSnapshots(base: readonly SnapshotLine[], pr: readonly SnapshotLine[]): Hunk[] {
  const pairs = commonLines(
    base.map((l) => `${l.depth}|${l.text}`),
    pr.map((l) => `${l.depth}|${l.text}`),
  );
  const hunks: Hunk[] = [];
  let [i, j] = [0, 0];
  for (const [ci, cj] of [...pairs, [base.length, pr.length] as [number, number]]) {
    if (ci > i || cj > j) {
      const baseIndex = Array.from({ length: ci - i }, (_, k) => i + k);
      const prIndex = Array.from({ length: cj - j }, (_, k) => j + k);
      hunks.push({
        id: `h${hunks.length + 1}`,
        landmark:
          prIndex.length > 0 ? landmarkOf(pr, prIndex[0]!) : landmarkOf(base, baseIndex[0]!),
        removed: baseIndex.map((k) => base[k]!),
        added: prIndex.map((k) => pr[k]!),
        baseIndex,
        prIndex,
      });
    }
    [i, j] = [ci + 1, cj + 1];
  }
  return hunks;
}

/**
 * Lines a criterion touches, by snapshot index: its trigger targets and its watched elements, with
 * everything under them. A watched region doesn't count: the change the demo reports sits inside
 * one (DECISIONS 2026-11-01), so region changes go to the classifier instead.
 */
export interface Touched {
  base: ReadonlySet<number>;
  pr: ReadonlySet<number>;
}

/** The lines under each of these lines (deeper, until the depth comes back), and the lines. */
export function subtrees(lines: readonly SnapshotLine[], roots: readonly number[]): Set<number> {
  const out = new Set<number>();
  for (const root of roots) {
    out.add(root);
    const depth = lines[root]!.depth;
    for (let k = root + 1; k < lines.length && lines[k]!.depth > depth; k++) out.add(k);
  }
  return out;
}

/**
 * §24: what a criterion's trigger or watched element touches is expected. Line by line, since a
 * diff merges neighbouring changes into one hunk: a touched line goes, and so does a changed
 * container holding one (the discount form around the field the trigger fills), with what it holds.
 * A hunk left with no lines goes.
 */
export function dropExpected(
  hunks: readonly Hunk[],
  touched: Touched,
  base: readonly SnapshotLine[],
  pr: readonly SnapshotLine[],
): Hunk[] {
  const keep = (
    index: readonly number[],
    lines: readonly SnapshotLine[],
    set: ReadonlySet<number>,
  ) => {
    const inHunk = new Set(index);
    const roots = index.filter((k) => {
      if (set.has(k)) return true;
      for (let c = k + 1; c < lines.length && lines[c]!.depth > lines[k]!.depth; c++) {
        if (set.has(c)) return true;
      }
      return false;
    });
    const dropped = subtrees(lines, roots);
    return index.filter((k) => inHunk.has(k) && !dropped.has(k));
  };
  return hunks.flatMap((hunk) => {
    const baseIndex = keep(hunk.baseIndex, base, touched.base);
    const prIndex = keep(hunk.prIndex, pr, touched.pr);
    if (baseIndex.length === 0 && prIndex.length === 0) return [];
    return [
      {
        ...hunk,
        baseIndex,
        prIndex,
        removed: baseIndex.map((k) => base[k]!),
        added: prIndex.map((k) => pr[k]!),
      },
    ];
  });
}

/** A hunk as one short phrase for the classifier and the report: `link "Checkout" → "Continue"`. */
export function describeHunk(hunk: Hunk): string {
  const show = (lines: readonly SnapshotLine[]) =>
    lines
      .map((l) => l.text.replace(/^- /, "").replace(/:$/, ""))
      .join(" / ")
      .slice(0, 160);
  if (hunk.removed.length === 0) return `added ${show(hunk.added)}`;
  if (hunk.added.length === 0) return `removed ${show(hunk.removed)}`;
  // One element renamed: `link "Checkout" → "Continue"`, as the golden comment writes it.
  const named = /^- ([\w-]+) "(.*)":?$/;
  const [from, to] = [named.exec(hunk.removed[0]!.text), named.exec(hunk.added[0]!.text)];
  if (hunk.removed.length === 1 && hunk.added.length === 1 && from && to && from[1] === to[1]) {
    return `${from[1]} "${from[2]}" → "${to[2]}"`;
  }
  return `${show(hunk.removed)} → ${show(hunk.added)}`;
}
