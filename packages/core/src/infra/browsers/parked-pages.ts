/** @module infra/browsers/parked-pages — the parked pages of a template host (spec 13 §3.4): pages no session owns, bounded per host, and closed when they commit a `data:` document (spec 13 §17 follow-up 1). */

import type { Frame, Page } from 'playwright';
import type { Clock } from '../../ports/clock.ts';
import type { Logger } from '../../ports/logger.ts';
import type { ParkedPageInfo } from '../../ports/template-host.ts';

/** Parked pages kept open per host, the sentinel excluded (spec 13 §3.4). */
export const MAX_PARKED_PAGES = 10;

/** True for a URL whose scheme is `data:` (case-insensitive, as Chromium reports it). */
function isDataUrl(url: string): boolean {
  return /^\s*data:/i.test(url);
}

/**
 * The parked pages of one host, oldest first. A page beyond {@link MAX_PARKED_PAGES} closes the
 * oldest; a parked page whose main frame commits `data:` is closed, as a template session's page is
 * (an agent cannot reach a parked page, but a session's site could still open one through it).
 */
export class ParkedPages {
  private readonly pages = new Map<Page, ParkedPageInfo>();
  private readonly clock: Clock;
  private readonly log: Logger;

  constructor(clock: Clock, logger: Logger) {
    this.clock = clock;
    this.log = logger;
  }

  /** Records a parked page; closes the oldest beyond the bound. */
  add(page: Page, targetId: string): void {
    this.pages.set(page, { targetId, url: '', openedAt: this.clock.now() });
    page.once('close', () => this.pages.delete(page));
    this.guardData(page);
    if (this.pages.size <= MAX_PARKED_PAGES) return;
    const oldest = this.pages.keys().next();
    if (oldest.done === true) return;
    this.pages.delete(oldest.value);
    this.log.info('parked page closed', { reason: 'limit', limit: MAX_PARKED_PAGES });
    void oldest.value.close({ runBeforeUnload: false }).catch(() => undefined);
  }

  /** Forgets a page (it became the sentinel). */
  delete(page: Page): void {
    this.pages.delete(page);
  }

  /** The open parked pages with their current URLs, oldest first. */
  list(): readonly ParkedPageInfo[] {
    return [...this.pages].map(([page, info]) => ({ ...info, url: urlOf(page) }));
  }

  private guardData(page: Page): void {
    const emitter: { on?: unknown } = page;
    if (typeof emitter.on !== 'function') return;
    const check = (url: string): void => {
      if (!isDataUrl(url)) return;
      this.log.warn('parked data: page closed', { scheme: 'data' });
      void page.close({ runBeforeUnload: false }).catch(() => undefined);
    };
    page.on('framenavigated', (frame: Frame) => {
      if (frame.parentFrame() === null) check(frame.url());
    });
    check(urlOf(page));
  }
}

function urlOf(page: Page): string {
  try {
    return page.url();
  } catch {
    return '';
  }
}
