/**
 * Formats a duration for PR comments and the report page, e.g. "45 s", "1 m 52 s", "1 h 3 m".
 * Rounds to the nearest second; negative or non-finite input is a programming error.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    throw new RangeError(`formatDuration: expected a non-negative finite number, got ${ms}`);
  }

  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return minutes > 0 ? `${hours} h ${minutes} m` : `${hours} h`;
  if (minutes > 0) return seconds > 0 ? `${minutes} m ${seconds} s` : `${minutes} m`;
  return `${seconds} s`;
}
