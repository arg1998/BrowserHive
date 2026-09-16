/** @module app/blocklist/blocklist-service.test — tool + request layers, reload atomicity, typed load failure, debounced watcher. */
import { describe, expect, it } from 'bun:test';
import { CollectingLogger } from '../../../test/helpers/collecting-logger.ts';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { FakeIdGenerator } from '../../../test/helpers/fake-id-generator.ts';
import { isAppError } from '../../kernel/errors/app-error.ts';
import type { Degradation } from '../../ports/degradation-reporter.ts';
import { InProcessEventBus } from '../events/bus.ts';
import type { DomainEvents } from '../events/catalog.ts';
import {
  BLOCKLIST_WATCH_DEBOUNCE_MS,
  type BlocklistFileWatcher,
  BlocklistService,
  type Schedule,
} from './blocklist-service.ts';

function setup(files: Record<string, string>, options: { readonly noPath?: boolean } = {}) {
  const path = options.noPath === true ? undefined : '/etc/blocklist.txt';
  const clock = new FakeClock(1_700_000_000_000);
  const logger = new CollectingLogger();
  const bus = new InProcessEventBus<DomainEvents>({ clock, logger });
  const hits: DomainEvents['blocklist.hit'][] = [];
  const reloads: DomainEvents['blocklist.reloaded'][] = [];
  bus.subscribe('blocklist.hit', (e) => {
    hits.push(e.payload);
  });
  bus.subscribe('blocklist.reloaded', (e) => {
    reloads.push(e.payload);
  });
  const degradations: Degradation[] = [];
  const recovered: string[] = [];
  const store = { ...files };
  const service = new BlocklistService({
    path,
    fs: {
      readFile: async (p) => {
        const body = store[p];
        if (body === undefined) throw new Error(`ENOENT: ${p}`);
        return body;
      },
    },
    bus,
    clock,
    ids: new FakeIdGenerator(),
    logger,
    degradations: {
      report: (d) => {
        degradations.push(d);
      },
      recovered: (code) => {
        recovered.push(code);
      },
    },
    sessionSlug: (id) => (id.startsWith('shop-') ? 'shop' : null),
  });
  return { service, clock, logger, hits, reloads, degradations, recovered, store };
}

describe('BlocklistService', () => {
  it('loads the configured file and reports skipped lines', async () => {
    const { service, logger } = setup({
      '/etc/blocklist.txt': 'example.com\n# comment\n*\nexample.com\n',
    });
    const rules = await service.load();
    expect(rules.entries.map((e) => e.pattern)).toEqual(['example.com']);
    expect(rules.skipped.map((s) => s.line)).toEqual([3, 4]);
    expect(service.active).toBe(true);
    expect(service.stats().patterns).toBe(1);
    expect(logger.has('blocklist loaded')).toBe(true);
  });

  it('a configured but unreadable file is a typed BLOCKLIST_LOAD_FAILED', async () => {
    const { service } = setup({});
    let caught: unknown;
    try {
      await service.load();
    } catch (err) {
      caught = err;
    }
    expect(isAppError(caught, 'BLOCKLIST_LOAD_FAILED')).toBe(true);
    if (isAppError(caught, 'BLOCKLIST_LOAD_FAILED')) {
      expect(caught.details.path).toBe('/etc/blocklist.txt');
      expect(caught.publicMessage.startsWith('Cannot load blocklist /etc/blocklist.txt: ')).toBe(
        true,
      );
      expect(caught.cause).toBeInstanceOf(Error);
    }
  });

  it('without a path it never blocks and never throws', async () => {
    const { service } = setup({}, { noPath: true });
    await service.load();
    expect(service.configured).toBe(false);
    expect(service.match('https://example.com')).toBeNull();
    service.assertAllowed('https://example.com', { tool: 'navigate' });
  });

  it('tool layer: throws URL_BLOCKED with the registry text and records a source=tool hit', async () => {
    const { service, hits, clock } = setup({ '/etc/blocklist.txt': 'ads.example.com\n' });
    await service.load();
    let caught: unknown;
    try {
      service.assertAllowed('https://ads.example.com/pixel?id=1&utm=x', {
        sessionId: 'shop-00000001',
        tool: 'navigate',
        toolEventId: 'e-00000000000000000000000009',
      });
    } catch (err) {
      caught = err;
    }
    expect(isAppError(caught, 'URL_BLOCKED')).toBe(true);
    if (isAppError(caught, 'URL_BLOCKED')) {
      expect(caught.details).toEqual({
        url: 'https://ads.example.com/pixel?id=1&utm=x',
        pattern: 'ads.example.com',
      });
      expect(caught.publicMessage).toBe(
        "The URL 'https://ads.example.com/pixel?id=1&utm=x' is blocked by the administrator (matched the blocklist pattern 'ads.example.com'). This is an operator policy, not a transient failure — do not retry this URL, and do not try to reach it by another route. Report it to the user if the task cannot continue.",
      );
      expect(caught.retryable).toBe('never');
    }
    expect(hits).toHaveLength(1);
    const row = hits[0]?.row;
    expect(row?.source).toBe('tool');
    expect(row?.tool).toBe('navigate');
    expect<string | null | undefined>(row?.session_id).toBe('shop-00000001');
    expect(row?.session_slug).toBe('shop');
    expect<string | null | undefined>(row?.tool_event_id).toBe('e-00000000000000000000000009');
    // D-20: the audit URL is sanitized (query stripped) before it leaves the service.
    expect(row?.url).toBe('https://ads.example.com/pixel');
    expect(row?.domain).toBe('ads.example.com');
    expect(row?.ts).toBe(clock.now());
    expect(service.stats().hits).toEqual({ tool: 1, request: 0 });
  });

  it('request layer: the observer records source=request without a tool', async () => {
    const { service, hits } = setup({ '/etc/blocklist.txt': 'example.com\n' });
    await service.load();
    service.requestObserver.blocked({
      sessionId: 'shop-00000001',
      url: 'https://example.com/a',
      pattern: 'example.com',
      source: 'request',
      ts: 5,
    });
    expect(hits[0]?.row.source).toBe('request');
    expect(hits[0]?.row.tool).toBeNull();
    expect(hits[0]?.row.tool_event_id).toBeNull();
    expect(service.stats().hits).toEqual({ tool: 0, request: 1 });
  });

  it('reload replaces the rules atomically and publishes blocklist.reloaded', async () => {
    const { service, store, reloads, recovered } = setup({ '/etc/blocklist.txt': 'a.com\n' });
    await service.load();
    const before = service.holder.version;
    store['/etc/blocklist.txt'] = 'b.com\nc.com\n';
    const result = await service.reload();
    expect(result).toEqual({ patterns: 2, skipped: 0 });
    expect(service.match('https://a.com')).toBeNull();
    expect(service.match('https://b.com/x')?.pattern).toBe('b.com');
    expect(service.holder.version).toBe(before + 1);
    expect(reloads).toHaveLength(1);
    expect(reloads[0]?.patterns).toBe(2);
    expect(recovered).toEqual(['BLOCKLIST_RELOAD_FAILED']);
  });

  it('a failed reload keeps the previous rules, reports a degradation and rethrows typed', async () => {
    const { service, store, degradations, reloads } = setup({ '/etc/blocklist.txt': 'a.com\n' });
    await service.load();
    delete store['/etc/blocklist.txt'];
    let caught: unknown;
    try {
      await service.reload();
    } catch (err) {
      caught = err;
    }
    expect(isAppError(caught, 'BLOCKLIST_LOAD_FAILED')).toBe(true);
    expect(service.match('https://a.com')?.pattern).toBe('a.com');
    expect(degradations.map((d) => d.code)).toEqual(['BLOCKLIST_RELOAD_FAILED']);
    expect(reloads).toHaveLength(0);
  });

  it('watch debounces bursts of change events into one reload', async () => {
    const { service, store } = setup({ '/etc/blocklist.txt': 'a.com\n' });
    await service.load();
    const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
    const schedule: Schedule = (fn, ms) => {
      const entry = { fn, ms, cancelled: false };
      timers.push(entry);
      return () => {
        entry.cancelled = true;
      };
    };
    const watched = new BlocklistService({
      path: '/etc/blocklist.txt',
      fs: { readFile: async (p) => store[p] ?? '' },
      bus: new InProcessEventBus<DomainEvents>({
        clock: new FakeClock(),
        logger: new CollectingLogger(),
      }),
      clock: new FakeClock(),
      ids: new FakeIdGenerator(),
      logger: new CollectingLogger(),
      holder: service.holder,
      schedule,
    });
    let onChange: () => void = () => undefined;
    const watcher: BlocklistFileWatcher = {
      watch: (_path, cb) => {
        onChange = cb;
        return () => undefined;
      },
    };
    const unwatch = watched.watch(watcher);
    store['/etc/blocklist.txt'] = 'z.com\n';
    onChange();
    onChange();
    onChange();
    expect(timers).toHaveLength(3);
    expect(timers.filter((t) => t.cancelled)).toHaveLength(2);
    expect(timers[2]?.ms).toBe(BLOCKLIST_WATCH_DEBOUNCE_MS);
    timers[2]?.fn();
    await Promise.resolve();
    await Promise.resolve();
    expect(service.match('https://z.com')?.pattern).toBe('z.com');
    unwatch();
  });
});
