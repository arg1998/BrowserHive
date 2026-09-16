/** @module kernel/duration — millisecond duration formatting for CLI and dashboard rendering. */

/** Options for {@link formatDuration}. */
export interface FormatDurationOptions {
  /**
   * `compact` (default): `1h 03m`, `4m 12s`, `9s`, `412ms` — the dashboard form, with a
   * sub-second tier. `clock`: `H:MM:SS` for elapsed counters.
   */
  readonly style?: 'compact' | 'clock';
}

/**
 * Formats a millisecond duration for humans. Non-positive or non-finite input renders as `0ms`
 * (compact) or `0:00:00` (clock).
 */
export function formatDuration(ms: number, options: FormatDurationOptions = {}): string {
  const style = options.style ?? 'compact';
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const totalSeconds = Math.floor(safe / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;

  if (style === 'clock') {
    return `${h}:${pad2(m)}:${pad2(s)}`;
  }
  if (safe < 1000) return `${Math.round(safe)}ms`;
  if (h > 0) return `${h}h ${pad2(m)}m`;
  if (m > 0) return `${m}m ${pad2(s)}s`;
  if (safe < 10_000) {
    const tenths = Math.floor(safe / 100) / 10;
    return Number.isInteger(tenths) ? `${tenths}s` : `${tenths.toFixed(1)}s`;
  }
  return `${s}s`;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}
