/** @module lib/format/time — relative/absolute time and duration formatting (24 h clock, browser timezone, spec 04 §11) */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Format a ms duration as `1h 03m`, `4m 12s`, `9s`. */
export function formatDuration(ms: number): string {
  if (ms <= 0) return '0s';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

/** Compact "time ago"/"in" text anchored on `now` (server-anchored by callers). */
export function formatRelative(at: number, now: number): string {
  const delta = now - at;
  const abs = Math.abs(delta);
  if (abs < 45_000) return delta >= 0 ? 'just now' : 'in a moment';
  const text =
    abs < HOUR ? `${Math.round(abs / MINUTE)}m` : formatDuration(abs).replace(/ 0+m$/, '');
  if (abs >= DAY) {
    const days = Math.floor(abs / DAY);
    return delta >= 0 ? `${days}d ago` : `in ${days}d`;
  }
  return delta >= 0 ? `${text} ago` : `in ${text}`;
}

const absoluteFormat = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
  timeZoneName: 'shortOffset',
});

/** Full absolute form for tooltips: `Jul 3, 2026, 14:05:22 GMT+2`. */
export function formatAbsolute(at: number): string {
  return absoluteFormat.format(new Date(at));
}

const shortFormat = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** Short absolute form for table "Time" columns: `Jul 3, 14:05`. */
export function formatAbsoluteShort(at: number): string {
  return shortFormat.format(new Date(at));
}

const clockFormat = new Intl.DateTimeFormat('en-US', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/** Mono clock for log lines: `14:05:22`. */
export function formatClock(at: number): string {
  return clockFormat.format(new Date(at));
}

/** Milliseconds as a compact duration for tool calls: `12 ms`, `1.4 s`, `2m 03s`. */
export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < MINUTE) return `${(ms / 1000).toFixed(1)} s`;
  return formatDuration(ms);
}

/** Day group label for notification lists: `Today`, `Yesterday`, `Mon 3`. */
export function formatDayGroup(at: number, now: number): string {
  const day = new Date(at);
  const today = new Date(now);
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((startOf(today) - startOf(day)) / DAY);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return new Intl.DateTimeFormat('en-US', { weekday: 'short', day: 'numeric' }).format(day);
}
