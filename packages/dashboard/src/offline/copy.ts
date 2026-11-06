/** @module offline/copy — what the offline page says for each state (04 §18.6.2) and the "last used" line. Pure. */
import type { DaemonState } from '../lib/daemon-help/probe.ts';

/** Every state the page shows: the daemon states plus the reload loop guard (04 §18.6.4). */
export type PageState = DaemonState | 'loop-guard';

/** A run of text, or a value rendered as inline code (`host`, flags). */
export type Segment = string | { readonly code: string };

/** The visual tone of the state badge. */
export type Tone = 'info' | 'danger' | 'warn' | 'neutral' | 'success';

/** The words for one state. */
export interface StateCopy {
  /** The `h1`. */
  readonly heading: string;
  /** The paragraph below it; empty for `checking`. */
  readonly body: readonly Segment[];
  /** The short badge label beside the address. */
  readonly badge: string;
  readonly tone: Tone;
  /** The badge dot pulses (unless reduced motion) while the page waits for something to happen. */
  readonly busy: boolean;
}

/** What the copy depends on besides the state. */
export interface CopyContext {
  /** `location.host`. */
  readonly host: string;
  /** `localhost`, `127.0.0.0/8` or `[::1]`. */
  readonly loopback: boolean;
  /** The HTTP status of the last marked, non-health answer (`refused`). */
  readonly status: number | null;
}

const RECONNECTS = 'This page reconnects by itself.';

/** The heading, body and badge for a state (04 §18.6.2). */
export function stateCopy(state: PageState, context: CopyContext): StateCopy {
  const host = { code: context.host };
  switch (state) {
    case 'checking':
      return {
        heading: `Checking BrowserHive at ${context.host}…`,
        body: [],
        badge: 'Checking',
        tone: 'info',
        busy: true,
      };
    case 'not-running':
      return context.loopback
        ? {
            heading: "BrowserHive isn't running",
            body: [
              'Nothing is answering at ',
              host,
              `. If you just started it, it may still be getting ready. ${RECONNECTS}`,
            ],
            badge: 'Not running',
            tone: 'danger',
            busy: false,
          }
        : {
            heading: "Can't reach BrowserHive",
            body: [
              'Nothing answered at ',
              host,
              `. Check this device's connection and any tunnel or proxy in between, and that BrowserHive is running. ${RECONNECTS}`,
            ],
            badge: 'Unreachable',
            tone: 'danger',
            busy: false,
          };
    case 'device-offline':
      return {
        heading: 'This device is offline',
        body: [`Reconnect to the network. ${RECONNECTS}`],
        badge: 'Offline',
        tone: 'neutral',
        busy: false,
      };
    case 'not-responding':
      return {
        heading: "BrowserHive isn't responding",
        body: [
          'Something at ',
          host,
          " accepted the connection but didn't answer within 5 seconds. BrowserHive may be stuck or overloaded. Restarting it usually helps.",
        ],
        badge: 'Not responding',
        tone: 'warn',
        busy: false,
      };
    case 'starting':
      return {
        heading: 'BrowserHive is starting',
        body: ['It is getting ready. This page opens the dashboard as soon as it is.'],
        badge: 'Starting',
        tone: 'info',
        busy: true,
      };
    case 'proxy-unreachable':
      return {
        heading: `BrowserHive is unreachable behind ${context.host}`,
        body: [
          'The proxy or tunnel at ',
          host,
          " answered, but BrowserHive behind it didn't. Check that BrowserHive is running and that the proxy points at it.",
        ],
        badge: 'Upstream down',
        tone: 'warn',
        busy: false,
      };
    case 'refused':
      return {
        heading: 'BrowserHive turned this request away',
        body: [
          'BrowserHive is running at ',
          host,
          ` but didn't accept this address (HTTP ${context.status ?? 'error'}). If you reach it through a new name, allow it with `,
          { code: '--allowedHosts' },
          ' or set ',
          { code: '--publicUrl' },
          ', or open the address the startup banner prints.',
        ],
        badge: 'Refused',
        tone: 'warn',
        busy: false,
      };
    case 'foreign':
      return {
        heading: 'Another program is using this address',
        body: [
          'Something other than BrowserHive answered at ',
          host,
          '. If BrowserHive moved to another port, open that address (and install the app from there).',
        ],
        badge: 'Address in use',
        tone: 'warn',
        busy: false,
      };
    case 'loop-guard':
      return {
        heading: "BrowserHive answers, but the dashboard didn't load",
        body: ['Reload, or restart BrowserHive.'],
        badge: 'Reload needed',
        tone: 'warn',
        busy: false,
      };
    case 'ready':
      return {
        heading: 'BrowserHive is ready',
        body: ['Opening the dashboard…'],
        badge: 'Ready',
        tone: 'success',
        busy: true,
      };
    default:
      return stateCopy('checking', context);
  }
}

/** The text of a run of segments. */
export function segmentsText(segments: readonly Segment[]): string {
  return segments.map((s) => (typeof s === 'string' ? s : s.code)).join('');
}

const UNITS: readonly (readonly [Intl.RelativeTimeFormatUnit, number])[] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
];

/** `3 hours ago`, `yesterday`, `a moment ago` (under a minute, or a clock that went backwards). */
export function timeAgo(thenMs: number, nowMs: number): string {
  const seconds = Math.floor((nowMs - thenMs) / 1000);
  const format = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  for (const [unit, size] of UNITS) {
    if (seconds >= size) return format.format(-Math.floor(seconds / size), unit);
  }
  return 'a moment ago';
}

/** "You last used BrowserHive 0.x.y here 3 hours ago." */
export function lastUsedText(version: string, seenAt: number, nowMs: number): string {
  return `You last used BrowserHive ${version} here ${timeAgo(seenAt, nowMs)}.`;
}
