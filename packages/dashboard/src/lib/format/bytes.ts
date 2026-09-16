/** @module lib/format/bytes — byte counts and numbers in en-US (spec 04 §11) */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/** `1.2 MB`, `840 KB`, `12 B` (binary steps, one decimal above KB). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = unit === 0 ? String(Math.round(value)) : value.toFixed(value >= 100 ? 0 : 1);
  return `${text} ${UNITS[unit] ?? 'B'}`;
}

const integerFormat = new Intl.NumberFormat('en-US');
const percentFormat = new Intl.NumberFormat('en-US', {
  style: 'percent',
  maximumFractionDigits: 1,
});

/** Thousands-separated integer. */
export function formatNumber(value: number): string {
  return integerFormat.format(value);
}

/** Ratio (0–1) as a percentage with at most one decimal. */
export function formatPercent(ratio: number): string {
  return percentFormat.format(ratio);
}
