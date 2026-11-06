/** @module offline/page — the offline page (04 §18.6): probes `/health`, says what is wrong and how to
 * fix it, reconnects by itself and reloads into the dashboard when BrowserHive is ready. Every
 * browser global it touches comes in through {@link OfflineEnv}, so tests mount it in happy-dom
 * with fakes.
 */
import { copyText } from '../lib/clipboard.ts';
import type { Clock, Timers } from '../lib/clock.ts';
import {
  type DaemonHelp,
  daemonHelp,
  detectPlatform,
  groupByPurpose,
  type HelpCommand,
  helpCommandsFor,
} from '../lib/daemon-help/commands.ts';
import {
  lastUsedText,
  type PageState,
  type Segment,
  stateCopy,
  type Tone,
} from '../lib/daemon-help/copy.ts';
import { LAST_SEEN_KEY, parseLastSeen } from '../lib/daemon-help/keys.ts';
import { classifyProbe, type ProbeOutcome } from '../lib/daemon-help/probe.ts';
import { docsUrl } from '../lib/links.ts';
import { readStorage, readStorageJson } from '../lib/storage.ts';
import {
  parsePreference,
  type ResolvedTheme,
  resolveTheme,
  THEME_COLORS,
  THEME_STORAGE_KEY,
} from '../theme/resolve.ts';
import { type Child, el, replaceChildren } from './dom.ts';
import { brandMark, icon } from './icons.ts';
import { Poller } from './poller.ts';
import { claimAutoReload } from './reload-guard.ts';

/** The worker's caches (`sw-core` `CACHE_PREFIX`; the offline page may not import `src/sw`). */
export const OFFLINE_CACHE_PREFIX = 'bh-offline-';

/** The page's own path; opened directly, a ready daemon sends it to `/` instead of reloading it. */
export const OFFLINE_PAGE_PATH = '/offline.html';

/** What "Forget this address" says when it is done. */
export const FORGOTTEN_TEXT =
  "Done. From now on this address shows your browser's normal page when nothing answers.";

/** The members of `Location` the page uses. */
export interface OfflineLocation {
  readonly protocol: string;
  readonly hostname: string;
  readonly port: string;
  readonly host: string;
  readonly pathname: string;
  reload(): void;
  replace(url: string): void;
}

/** A service worker registration, as far as Forget this address needs it. */
export interface OfflineRegistration {
  readonly scope: string;
  unregister(): Promise<boolean>;
}

/** The members of `Navigator` the page uses. */
export interface OfflineNavigator {
  readonly onLine: boolean;
  readonly userAgent: string;
  readonly userAgentData?: { readonly platform?: string } | undefined;
  readonly serviceWorker?:
    | { getRegistrations(): Promise<readonly OfflineRegistration[]> }
    | undefined;
}

/** A media query the page follows. */
export interface OfflineMediaQuery {
  readonly matches: boolean;
  addEventListener(type: 'change', listener: () => void): void;
  removeEventListener(type: 'change', listener: () => void): void;
}

/** Every global the page touches. */
export interface OfflineEnv {
  readonly document: Document;
  readonly window: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  readonly location: OfflineLocation;
  readonly navigator: OfflineNavigator;
  /** `window.caches`; absent outside a secure context. */
  readonly caches?: Pick<CacheStorage, 'keys' | 'delete'> | undefined;
  readonly matchMedia: (query: string) => OfflineMediaQuery;
  readonly probe: () => Promise<ProbeOutcome>;
  readonly timers: Timers;
  readonly clock: Clock;
}

/** The mounted page. */
export interface OfflinePage {
  /** The state on screen. */
  readonly state: () => PageState;
  /** Removes listeners and timers (tests). */
  readonly dispose: () => void;
}

const TONES: Record<Tone, string> = {
  info: 'border-info-border bg-info-bg text-info-text',
  danger: 'border-danger-border bg-danger-bg text-danger-text',
  warn: 'border-warn-border bg-warn-bg text-warn-text',
  neutral: 'border-neutral-border bg-neutral-bg text-neutral-text',
  success: 'border-success-border bg-success-bg text-success-text',
};

const BUTTON =
  'inline-flex h-9 shrink-0 cursor-pointer items-center justify-center gap-2 rounded-md border px-3.5 text-base font-medium whitespace-nowrap transition-[color,background-color,border-color,box-shadow] duration-(--duration-fast) select-none focus-ring pointer-coarse:h-10 [&_svg]:size-4 [&_svg]:shrink-0';
const PRIMARY = `${BUTTON} border-transparent bg-primary text-primary-foreground shadow-xs hover:bg-primary-hover`;
const OUTLINE = `${BUTTON} border-input bg-card text-foreground shadow-xs hover:border-border-strong hover:bg-accent dark:bg-transparent dark:hover:bg-accent`;
const QUIET =
  'cursor-pointer rounded-xs text-sm text-muted-foreground underline-offset-4 transition-colors duration-(--duration-fast) hover:text-foreground hover:underline focus-ring';
const COPY =
  'inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-sm font-medium text-muted-foreground transition-colors duration-(--duration-fast) hover:bg-accent hover:text-foreground focus-ring pointer-coarse:h-9 [&_svg]:size-3.5 data-[copied=true]:text-success-text';
const DOT = 'size-1.5 shrink-0 rounded-full bg-current';
const DOT_BUSY = 'size-1.5 shrink-0 rounded-full bg-current motion-safe:animate-pulse-soft';
const INLINE_CODE =
  'rounded-sm bg-muted px-1 py-px font-mono text-[0.875em] text-foreground [overflow-wrap:anywhere] dark:bg-white/[0.07]';

function timeOfDay(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** Mounts the page into `root` and starts probing. */
export function mountOfflinePage(env: OfflineEnv, root: HTMLElement): OfflinePage {
  const doc = env.document;
  const cleanups: (() => void)[] = [];
  const listen = (
    target: Pick<Window, 'addEventListener' | 'removeEventListener'>,
    type: string,
    fn: () => void,
  ): void => {
    target.addEventListener(type, fn);
    cleanups.push(() => target.removeEventListener(type, fn));
  };

  // ---- Theme first, so the tokens match the operator's choice from the first frame on. ----
  const media = env.matchMedia('(prefers-color-scheme: dark)');
  const applyTheme = (): void => {
    const theme: ResolvedTheme = resolveTheme(
      parsePreference(readStorage(THEME_STORAGE_KEY)),
      media.matches,
    );
    const html = doc.documentElement;
    html.setAttribute('data-theme', theme);
    html.style.colorScheme = theme;
    doc.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLORS[theme]);
  };
  applyTheme();
  media.addEventListener('change', applyTheme);
  cleanups.push(() => media.removeEventListener('change', applyTheme));

  // ---- What does not change while the page is open. ----
  const lastSeen = readStorageJson(LAST_SEEN_KEY, parseLastSeen);
  const help: DaemonHelp = daemonHelp({
    location: env.location,
    platform: detectPlatform({
      uaPlatform: env.navigator.userAgentData?.platform,
      userAgent: env.navigator.userAgent,
    }),
    lastSeenVersion: lastSeen?.version ?? null,
  });

  // ---- Skeleton. ----
  const badge = el(doc, 'span', {});
  const heading = el(doc, 'h1', {
    className: 'mt-4 text-2xl font-semibold tracking-tight text-balance',
    attrs: { id: 'offline-title' },
  });
  const body = el(doc, 'p', {
    className: 'mt-2 text-md text-pretty text-muted-foreground empty:hidden',
  });
  const commands = el(doc, 'div', { className: 'empty:hidden' });
  const lastUsed = el(doc, 'p', { className: 'text-sm text-muted-foreground empty:hidden' });
  const live = el(doc, 'span', { className: 'sr-only', attrs: { role: 'status' } });
  const copyLive = el(doc, 'span', { className: 'sr-only', attrs: { 'aria-live': 'polite' } });
  const countdown = el(doc, 'span', {});
  const primary = el(doc, 'button', { className: PRIMARY, attrs: { type: 'button' } });
  const forgetButton = el(doc, 'button', { className: OUTLINE, attrs: { type: 'button' } }, [
    'Forget this address',
  ]);
  const forgetLink = el(doc, 'button', { className: QUIET, attrs: { type: 'button' } }, [
    'Forget this address',
  ]);
  const forgotten = el(doc, 'p', {
    className:
      'mt-4 rounded-lg border border-success-border bg-success-bg px-3 py-2 text-sm text-success-text focus-ring',
    attrs: { tabindex: '-1', hidden: '' },
  });
  const actions = el(doc, 'div', { className: 'flex shrink-0 flex-wrap items-center gap-2' }, [
    primary,
  ]);

  replaceChildren(doc, root, [
    el(doc, 'div', { className: 'relative flex min-h-dvh flex-col bg-background' }, [
      el(doc, 'div', {
        className:
          'pointer-events-none absolute inset-x-0 top-0 h-80 bg-[radial-gradient(60%_100%_at_50%_0%,color-mix(in_oklch,var(--primary),transparent_90%),transparent)]',
        attrs: { 'aria-hidden': 'true' },
      }),
      el(
        doc,
        'main',
        {
          className:
            'relative flex flex-1 flex-col items-center px-gutter pt-[max(2rem,8vh)] pb-16',
          attrs: { id: 'main' },
        },
        [
          el(doc, 'div', { className: 'flex w-full max-w-[40rem] flex-col items-center gap-6' }, [
            el(doc, 'div', { className: 'flex flex-col items-center gap-3' }, [
              brandMark(doc, 'size-11 shrink-0'),
              el(doc, 'span', { className: 'text-md font-semibold tracking-tight' }, [
                'BrowserHive',
              ]),
            ]),
            el(
              doc,
              'section',
              {
                className:
                  'w-full overflow-hidden rounded-2xl border bg-card shadow-md dark:shadow-dialog',
                attrs: { 'aria-labelledby': 'offline-title' },
              },
              [
                el(doc, 'div', { className: 'p-6 sm:p-8' }, [
                  el(doc, 'div', { className: 'flex flex-wrap items-center gap-x-3 gap-y-2' }, [
                    badge,
                    el(doc, 'span', { className: 'font-mono text-sm text-muted-foreground' }, [
                      help.host,
                    ]),
                  ]),
                  heading,
                  body,
                  commands,
                  el(
                    doc,
                    'div',
                    {
                      className:
                        'mt-6 flex flex-col gap-4 border-t pt-6 sm:flex-row sm:items-center sm:justify-between',
                    },
                    [
                      actions,
                      el(
                        doc,
                        'p',
                        {
                          className:
                            'min-w-0 text-sm text-muted-foreground tabular-nums sm:text-right',
                        },
                        [live, countdown],
                      ),
                    ],
                  ),
                  forgotten,
                ]),
                el(
                  doc,
                  'footer',
                  {
                    className:
                      'flex flex-col gap-3 border-t bg-muted/60 px-6 py-4 sm:px-8 dark:bg-black/15',
                  },
                  [
                    lastUsed,
                    el(
                      doc,
                      'div',
                      { className: 'flex flex-wrap items-center justify-between gap-x-6 gap-y-2' },
                      [
                        el(
                          doc,
                          'a',
                          {
                            className:
                              'inline-flex items-center gap-1 rounded-xs text-sm font-medium text-link underline-offset-4 hover:underline focus-ring [&_svg]:size-3.5',
                            attrs: {
                              href: docsUrl('troubleshootingNotRunning'),
                              target: '_blank',
                              rel: 'noopener noreferrer',
                            },
                          },
                          ['Learn more about this page', icon(doc, 'external', '')],
                        ),
                        forgetLink,
                      ],
                    ),
                  ],
                ),
              ],
            ),
            copyLive,
          ]),
        ],
      ),
    ]),
  ]);

  if (lastSeen !== null) {
    lastUsed.textContent = lastUsedText(lastSeen.version, lastSeen.seen_at, env.clock());
  }

  // ---- State. ----
  let state: PageState = 'checking';
  let status: number | null = null;
  let lastCheckedAt: number | null = null;
  let rendered = '';
  let forgottenDone = false;

  function segments(parts: readonly Segment[]): Child[] {
    return parts.map((part) =>
      typeof part === 'string' ? part : el(doc, 'code', { className: INLINE_CODE }, [part.code]),
    );
  }

  function copyButton(command: HelpCommand): HTMLButtonElement {
    const what = command.label === null ? command.purpose : `${command.label} command`;
    const label = el(doc, 'span', { className: 'max-sm:sr-only' }, ['Copy']);
    const button = el(
      doc,
      'button',
      { className: COPY, attrs: { type: 'button', 'aria-label': `Copy: ${what}` } },
      [icon(doc, 'copy', ''), label],
    );
    let reset: ReturnType<typeof setTimeout> | null = null;
    button.addEventListener('click', () => {
      void copyText(command.command, doc).then((ok) => {
        replaceChildren(doc, button, [icon(doc, ok ? 'check' : 'copy', ''), label]);
        label.textContent = ok ? 'Copied' : 'Copy failed';
        button.dataset['copied'] = String(ok);
        copyLive.textContent = ok ? `Copied: ${command.command}` : 'Copy failed';
        if (reset !== null) env.timers.clearTimeout(reset);
        reset = env.timers.setTimeout(() => {
          replaceChildren(doc, button, [icon(doc, 'copy', ''), label]);
          label.textContent = 'Copy';
          button.dataset['copied'] = 'false';
        }, 1_500);
      });
    });
    return button;
  }

  /**
   * The command as words that each stay whole (inline blocks) unless one is longer than the line,
   * so a narrow screen wraps between words, never inside `--admin`. The spaces stay text, so a
   * manual selection copies the command as is.
   */
  function commandTokens(command: string): Child[] {
    return command
      .split(' ')
      .flatMap((word, i) => [
        i === 0 ? null : ' ',
        el(doc, 'span', { className: 'inline-block' }, [word]),
      ]);
  }

  function commandRow(command: HelpCommand): HTMLElement {
    const row = el(
      doc,
      'div',
      {
        className:
          'flex min-w-0 flex-1 items-start gap-2 rounded-lg border bg-muted/50 py-1 pr-1 pl-3 dark:bg-black/20',
      },
      [
        el(
          doc,
          'code',
          {
            className:
              'min-w-0 flex-1 py-1 font-mono text-sm leading-5 whitespace-pre-wrap [overflow-wrap:anywhere]',
          },
          commandTokens(command.command),
        ),
        copyButton(command),
      ],
    );
    if (command.label === null) return row;
    return el(doc, 'div', { className: 'flex flex-col gap-1' }, [
      el(doc, 'span', { className: 'text-xs text-subtle-foreground' }, [command.label]),
      row,
    ]);
  }

  function renderCommands(list: readonly HelpCommand[]): Child[] {
    if (list.length === 0) return [];
    return [
      el(doc, 'div', { className: 'mt-6 flex flex-col gap-4' }, [
        el(doc, 'h2', { className: 'eyebrow' }, ['Commands']),
        help.remoteNote === null
          ? null
          : el(
              doc,
              'p',
              {
                className:
                  'rounded-lg border border-info-border bg-info-bg px-3 py-2 text-sm text-info-text',
              },
              [help.remoteNote],
            ),
        el(
          doc,
          'ul',
          { className: 'flex flex-col gap-4' },
          groupByPurpose(list).map((group) =>
            el(doc, 'li', { className: 'flex flex-col gap-1.5' }, [
              el(doc, 'span', { className: 'section-label' }, [group[0]?.purpose ?? '']),
              ...group.map(commandRow),
            ]),
          ),
        ),
        el(doc, 'p', { className: 'text-sm text-pretty text-muted-foreground' }, [help.footer]),
      ]),
    ];
  }

  function render(): void {
    const key = `${state}:${status ?? ''}`;
    if (key === rendered) return;
    const first = rendered === '';
    rendered = key;
    const copy = stateCopy(state, { host: help.host, loopback: help.loopback, status });
    badge.className = `inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${TONES[copy.tone]}`;
    replaceChildren(doc, badge, [
      el(doc, 'span', {
        className: copy.busy ? DOT_BUSY : DOT,
        attrs: { 'aria-hidden': 'true' },
      }),
      copy.badge,
    ]);
    heading.textContent = copy.heading;
    doc.title = `${copy.heading} · BrowserHive`;
    replaceChildren(doc, body, segments(copy.body));
    replaceChildren(
      doc,
      commands,
      renderCommands(helpCommandsFor(help, state === 'ready' ? 'checking' : state)),
    );
    const loopGuard = state === 'loop-guard';
    replaceChildren(doc, primary, [icon(doc, 'retry', ''), loopGuard ? 'Reload' : 'Retry now']);
    primary.hidden = state === 'ready';
    const quietForget = state !== 'foreign';
    if (quietForget && forgetButton.parentNode !== null) forgetButton.remove();
    if (!quietForget && forgetButton.parentNode === null && !forgottenDone) {
      actions.appendChild(forgetButton);
    }
    forgetLink.hidden = !quietForget || forgottenDone;
    // The region is mounted empty; the first state after load and every change are announced.
    if (!first || state !== 'checking') live.textContent = copy.heading;
  }

  // ---- Probing. ----
  const poller = new Poller({
    probe: env.probe,
    timers: env.timers,
    clock: env.clock,
    isVisible: () => doc.visibilityState !== 'hidden',
    onProbe: () => updateStatusLine(),
    onScheduled: () => updateStatusLine(),
    onOutcome: (outcome) => {
      lastCheckedAt = env.clock();
      status = outcome.kind === 'response' ? outcome.status : null;
      const next = classifyProbe(outcome, { online: env.navigator.onLine });
      if (next === 'ready') {
        poller.stop();
        if (claimAutoReload(env.clock())) {
          state = 'ready';
          render();
          updateStatusLine();
          if (env.location.pathname === OFFLINE_PAGE_PATH) env.location.replace('/');
          else env.location.reload();
          return;
        }
        state = 'loop-guard';
      } else {
        state = next;
      }
      render();
      updateStatusLine();
    },
  });

  function updateStatusLine(): void {
    const parts: string[] = [];
    if (state === 'ready') parts.push('Opening the dashboard…');
    else if (poller.probing) parts.push('Checking now…');
    else {
      const nextAt = poller.nextAt;
      if (nextAt !== null) {
        parts.push(`Checking again in ${Math.max(1, Math.ceil((nextAt - env.clock()) / 1000))} s`);
      }
      if (lastCheckedAt !== null) parts.push(`Last checked ${timeOfDay(lastCheckedAt)}`);
    }
    countdown.textContent = parts.join(' · ');
  }

  primary.addEventListener('click', () => {
    if (state === 'loop-guard') env.location.reload();
    else poller.probeNow(true);
  });

  async function forget(): Promise<void> {
    try {
      const registrations = (await env.navigator.serviceWorker?.getRegistrations()) ?? [];
      await Promise.all(
        registrations
          .filter((registration) => new URL(registration.scope).pathname === '/')
          .map((registration) => registration.unregister()),
      );
      const names = (await env.caches?.keys()) ?? [];
      await Promise.all(
        names
          .filter((name) => name.startsWith(OFFLINE_CACHE_PREFIX))
          .map((name) => env.caches?.delete(name)),
      );
      forgotten.textContent = FORGOTTEN_TEXT;
    } catch {
      forgotten.textContent =
        "Couldn't remove it. Clear this site's data in your browser's settings instead.";
    }
    forgottenDone = true;
    forgetButton.remove();
    forgetLink.hidden = true;
    forgotten.hidden = false;
    forgotten.focus();
  }
  forgetButton.addEventListener('click', () => void forget());
  forgetLink.addEventListener('click', () => void forget());

  listen(env.window, 'online', () => poller.probeNow(false));
  const onVisibility = (): void => {
    poller.visibilityChanged();
    updateStatusLine();
  };
  doc.addEventListener('visibilitychange', onVisibility);
  cleanups.push(() => doc.removeEventListener('visibilitychange', onVisibility));
  const ticker = env.timers.setInterval(updateStatusLine, 1_000);
  cleanups.push(() => env.timers.clearInterval(ticker));

  render();
  updateStatusLine();
  poller.start();

  return {
    state: () => state,
    dispose: () => {
      poller.stop();
      for (const cleanup of cleanups) cleanup();
    },
  };
}
