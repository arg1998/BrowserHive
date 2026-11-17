/** @module app/site-packs/strategies/single-focus — `single-focus` (spec 13 §9.4, §3.10): on one template host, only the page of a site the template's sessions acted on last keeps focus emulation; the site's other pages report their real focus. A page that leaves the site, or whose pack stops selecting the strategy, is focused again. In memory, per process. */

import { serializeError } from '../../../kernel/errors/serialize-error.ts';
import type { Logger } from '../../../ports/logger.ts';
import type { PageFocusControl } from '../../../ports/page-focus.ts';
import type { Page } from '../../../ports/page-types.ts';

/** Collaborators of {@link SingleFocus}. */
export interface SingleFocusDeps {
  readonly focus: PageFocusControl;
  /** Every page of the template's live (agent) sessions. */
  readonly pagesOf: (templateId: string) => readonly Page[];
  /** The id of the pack owning `url` when that pack selects `single-focus`, else `null`. */
  readonly singleFocusPackOf: (url: string) => string | null;
  readonly logger: Logger;
}

/** The arbiter of every template host. */
export class SingleFocus {
  readonly #deps: SingleFocusDeps;
  readonly #log: Logger;
  /** (template, pack) → the page acted on last. */
  readonly #last = new Map<string, Page>();
  /** Per template: arbitrations run one after the other. */
  readonly #chains = new Map<string, Promise<void>>();

  constructor(deps: SingleFocusDeps) {
    this.#deps = deps;
    this.#log = deps.logger.child({ module: 'site-packs.single-focus' });
  }

  /**
   * A session of `templateId` acts on `page` (`null`: nothing new, re-check every page): it becomes
   * its site's focused page, and every page of the template is set accordingly (`headless`: the
   * template's host is headless). Never throws.
   */
  arbitrate(templateId: string, page: Page | null, headless: boolean): Promise<void> {
    const previous = this.#chains.get(templateId) ?? Promise.resolve();
    const next = previous.then(() => this.#apply(templateId, page, headless));
    this.#chains.set(templateId, next);
    void next.then(() => {
      if (this.#chains.get(templateId) === next) this.#chains.delete(templateId);
    });
    return next;
  }

  /** Keeps the state of these templates only (the others have no live session left). */
  retain(templateIds: ReadonlySet<string>): void {
    for (const k of this.#last.keys()) {
      if (!templateIds.has(k.slice(0, k.indexOf('\u0000')))) this.#last.delete(k);
    }
  }

  async #apply(templateId: string, acted: Page | null, headless: boolean): Promise<void> {
    try {
      if (acted !== null && !acted.isClosed()) {
        const packId = this.#deps.singleFocusPackOf(safeUrl(acted));
        if (packId !== null) this.#last.set(key(templateId, packId), acted);
      }
      const pages = this.#deps.pagesOf(templateId);
      const updates: Promise<void>[] = [];
      for (const page of pages) {
        if (page.isClosed()) continue;
        const packId = this.#deps.singleFocusPackOf(safeUrl(page));
        const last = packId === null ? undefined : this.#last.get(key(templateId, packId));
        // Before the first action on the site every page keeps the driver's default; once the page
        // acted on last is closed, the others stay unfocused until the next action (one bounded
        // entry per template and site, dropped with the template's last session).
        const emulated = packId === null || last === undefined || last === page;
        updates.push(this.#deps.focus.setEmulated(page, emulated, headless));
      }
      await Promise.all(updates);
    } catch (err) {
      this.#log.warn('focus arbitration failed', { err: serializeError(err) });
    }
  }
}

function key(templateId: string, packId: string): string {
  return `${templateId}\u0000${packId}`;
}

function safeUrl(page: Page): string {
  try {
    return page.url();
  } catch {
    return 'about:blank';
  }
}
