/** @module kernel/bytes — byte-count formatting for CLI and dashboard rendering. */

/** Decimal units, matching what a file manager shows. */
const DECIMAL_UNITS: readonly string[] = ['kB', 'MB', 'GB', 'TB', 'PB'];

/** Binary units for the `--retentionBytes`-style operator surfaces. */
const BINARY_UNITS: readonly string[] = ['KiB', 'MiB', 'GiB', 'TiB', 'PiB'];

/** Options for {@link formatBytes}. */
export interface FormatBytesOptions {
  /** `decimal` (default, `1.2 MB`, base 1000) or `binary` (`1.2 MiB`, base 1024). */
  readonly unit?: 'decimal' | 'binary';
  /** Fraction digits above the base unit. Default `1`. */
  readonly digits?: number;
}

/**
 * `1.2 GB` / `18.4 MB` / `512 B`. Negative, non-finite or `NaN` input renders as `0 B`.
 */
export function formatBytes(n: number, options: FormatBytesOptions = {}): string {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  const base = options.unit === 'binary' ? 1024 : 1000;
  const units = options.unit === 'binary' ? BINARY_UNITS : DECIMAL_UNITS;
  const digits = options.digits ?? 1;
  const whole = Math.floor(n);
  if (whole < base) return `${whole} B`;
  let value = whole / base;
  let unit = 0;
  while (value >= base && unit < units.length - 1) {
    value /= base;
    unit += 1;
  }
  return `${value.toFixed(digits)} ${units[unit] ?? ''}`.trimEnd();
}
