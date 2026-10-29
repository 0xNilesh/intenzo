export function median(samples: readonly number[]): number {
  if (samples.length === 0) throw new RangeError("median: no samples");
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Latency summary stored with each probe result, rounded to whole milliseconds. */
export function latency(samples: readonly number[]): { p50: number; samples: number[] } {
  return { p50: Math.round(median(samples)), samples: samples.map((ms) => Math.round(ms)) };
}
