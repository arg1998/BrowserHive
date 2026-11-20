/** @module infra/browsers/session-cookies — keeps a template host's session-only cookies across Chrome's "last window closed" (spec 13 §3.2, D-78): Chrome drops every cookie without an expiry when its last window closes, even though a host started with no window keeps running, so BrowserHive reads them before a close it makes (or while a sign-in window is open) and puts back exactly those Chrome then drops, raw, through `Storage.getCookies`/`Storage.setCookies` (an unspecified SameSite, the source scheme and port, a CHIPS partition kept as they were). */

import type { CDPSession } from 'patchright';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { Logger } from '../../ports/logger.ts';

/** How long after a close Chrome may still drop session cookies (measured: about 20 ms). */
export const DROP_WATCH_MS = 3_000;
/** The watch goes on at least this long after the close (the drop is still to come, or repeats). */
const DROP_SETTLE_MS = 250;

/** A cookie partition (CHIPS) as DevTools reports it. */
interface PartitionKey {
  readonly topLevelSite: string;
  readonly hasCrossSiteAncestor: boolean;
}

/** A cookie as `Storage.getCookies` reports it (the fields BrowserHive puts back). */
export interface RawCookie {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: string;
  readonly httpOnly: boolean;
  readonly secure: boolean;
  readonly session: boolean;
  readonly sameSite?: 'Strict' | 'Lax' | 'None';
  readonly priority: 'Low' | 'Medium' | 'High';
  readonly sourceScheme: 'Unset' | 'NonSecure' | 'Secure';
  readonly sourcePort: number;
  readonly partitionKey?: PartitionKey;
}

/** The identity of a cookie in the jar: a same-named cookie in another partition is another one. */
export function cookieKey(c: RawCookie): string {
  const partition =
    c.partitionKey === undefined
      ? ''
      : `${c.partitionKey.topLevelSite}|${String(c.partitionKey.hasCrossSiteAncestor)}`;
  return `${c.name}\t${c.domain}\t${c.path}\t${partition}`;
}

/**
 * The `Storage.setCookies` parameter that recreates `c` as it was: host-only when its domain has no
 * leading dot (set through a URL), its SameSite left unset when it was unset, no expiry.
 */
export function cookieParamOf(c: RawCookie): Record<string, unknown> {
  const hostOnly = !c.domain.startsWith('.');
  return {
    name: c.name,
    value: c.value,
    ...(hostOnly
      ? { url: `${c.secure ? 'https' : 'http'}://${c.domain}${c.path}` }
      : { domain: c.domain }),
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    priority: c.priority,
    sourceScheme: c.sourceScheme,
    sourcePort: c.sourcePort,
    ...(c.sameSite !== undefined && { sameSite: c.sameSite }),
    ...(c.partitionKey !== undefined && { partitionKey: c.partitionKey }),
  };
}

/** What the keeper needs from its host. */
export interface CookieKeeperHost {
  /** The host's browser-level DevTools session. */
  readonly cdp: CDPSession;
  /** The persistent context's id (`null`: the default context, named by omission). */
  readonly browserContextId: string | null;
  readonly log: Logger;
  /** The host is closing: nothing is put back. */
  closing(): boolean;
  /** Pages adopted since `at` (a new window: the drop is over, and a site may change the jar). */
  adoptedSince(at: number): boolean;
}

/** Reads and puts back one host's session-only cookies. */
export class SessionCookieKeeper {
  private readonly host: CookieKeeperHost;

  constructor(host: CookieKeeperHost) {
    this.host = host;
  }

  /** The session-only cookies of the jar now; `[]` when they cannot be read. */
  async snapshot(): Promise<RawCookie[]> {
    try {
      const { cookies } = (await this.host.cdp.send('Storage.getCookies', this.contextParam())) as {
        cookies: RawCookie[];
      };
      return cookies.filter((c) => c.session);
    } catch (err) {
      this.host.log.debug('session cookies unread', { err: serializeError(err) });
      return [];
    }
  }

  /**
   * Puts back the cookies of `before` the jar lost, watching up to {@link DROP_WATCH_MS} after
   * `closedAt` for Chrome's drop; stops early once a page was adopted after the drop could have
   * happened (from then on the jar is a site's to change). Resolves with how many were put back.
   */
  async putBack(before: readonly RawCookie[], closedAt: number): Promise<number> {
    if (before.length === 0) return 0;
    const until = closedAt + DROP_WATCH_MS;
    let restored = 0;
    while (!this.host.closing()) {
      const now = new Set((await this.snapshotAll()).map(cookieKey));
      const lost = before.filter((c) => !now.has(cookieKey(c)));
      if (lost.length > 0) {
        try {
          await this.host.cdp.send('Storage.setCookies', {
            cookies: lost.map(cookieParamOf),
            ...this.contextParam(),
          } as never);
          restored += lost.length;
        } catch (err) {
          this.host.log.warn('session cookies lost', { err: serializeError(err) });
          return restored;
        }
      }
      // Chrome's drop may land in more than one step: watch until it has settled.
      const watched = Date.now() - closedAt;
      if (restored > 0 && watched >= DROP_SETTLE_MS) break;
      if (Date.now() >= until) break;
      if (watched >= DROP_SETTLE_MS && this.host.adoptedSince(closedAt)) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    if (restored > 0) this.host.log.info('session cookies kept', { count: restored });
    return restored;
  }

  /** Every cookie of the jar (session or not), for the loss check. */
  private async snapshotAll(): Promise<RawCookie[]> {
    try {
      const { cookies } = (await this.host.cdp.send('Storage.getCookies', this.contextParam())) as {
        cookies: RawCookie[];
      };
      return cookies;
    } catch {
      return [];
    }
  }

  private contextParam(): { browserContextId?: string } {
    return this.host.browserContextId === null
      ? {}
      : { browserContextId: this.host.browserContextId };
  }
}
