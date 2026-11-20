/** @module test/composition/strategy-state-restart.test — the strategy state survives a real restart (D53): a server boots on a data dir, a template's write budget is consumed and its launch turn reserved, the server stops cleanly (the shutdown flushes), and a second server on the same data dir restores both before anything decides; under `sitePacks=false` nothing is restored. */

import { afterAll, describe, expect, it } from 'bun:test';
import type { BootContext } from '../../src/composition/context.ts';
import { bootServer, type PhaseDefinition } from '../../src/composition/index.ts';
import { bootInputFor, tempDir } from './support.ts';

const TEMPLATE = 'tp-restart001';
const PACE = { templateId: TEMPLATE, packId: 'linkedin.com', scopeKey: 'invites' };
const HOUR = 3_600_000;

/** The phases, capturing the boot context once the domain exists. */
function capturing(seen: { ctx: BootContext | null }) {
  return (defaults: readonly PhaseDefinition[]): readonly PhaseDefinition[] =>
    defaults.map((phase) =>
      phase.name !== 'build-domain'
        ? phase
        : {
            ...phase,
            run: async (ctx) => {
              const handle = await phase.run(ctx);
              seen.ctx = ctx;
              return handle;
            },
          },
    );
}

/** A disabled template (nothing starts for it); the state rows reference it. */
function insertTemplate(ctx: BootContext, now: number): void {
  ctx.storage?.handle.raw.run(
    `INSERT INTO templates (template_id, name, display_name, status, owner, channel, stealth,
       fingerprint, humanize, identity_json, health_interval_ms, created_at, updated_at)
     VALUES (?, 'restart', 'Restart', 'disabled', 'local', 'chromium', 'standard', 0, 0, '{}',
       21600000, ?, ?)`,
    [TEMPLATE, now, now],
  );
}

describe('strategy state across a server restart', () => {
  const dir = tempDir();
  afterAll(() => dir.cleanup());

  it('a second boot on the same data dir sees the remaining budget and the launch turn', async () => {
    const seen: { ctx: BootContext | null } = { ctx: null };
    const first = await bootServer(bootInputFor(dir.path), { phases: capturing(seen) });
    const ctx = seen.ctx;
    if (ctx === null) throw new Error('no boot context');
    const state = ctx.domain?.strategyState;
    if (state == null) throw new Error('strategy state not built');
    const now = ctx.clock.now();
    insertTemplate(ctx, now);
    // Two of five writes used this hour; the next launch may go in 10 minutes. Queued as `soon`:
    // only the shutdown's flush writes them, within the flush interval.
    state.set('pace-writes', PACE, { tokens: 3, at: now, capacity: 5, periodMs: HOUR }, 'soon');
    state.set('launch-spacing', { templateId: TEMPLATE }, { nextAt: now + 600_000 }, 'soon');
    await first.stop();

    const again: { ctx: BootContext | null } = { ctx: null };
    const second = await bootServer(bootInputFor(dir.path), { phases: capturing(again) });
    try {
      const restored = again.ctx?.domain?.strategyState;
      const bucket = restored?.get('pace-writes', PACE);
      // Refilled only by the seconds the restart took, never back to the full 5.
      expect(bucket?.tokens).toBeGreaterThanOrEqual(3);
      expect(bucket?.tokens).toBeLessThan(3.1);
      expect(restored?.get('launch-spacing', { templateId: TEMPLATE })).toEqual({
        nextAt: now + 600_000,
      });
    } finally {
      await second.stop();
    }
  });

  it('builds no strategy state under sitePacks=false', async () => {
    const seen: { ctx: BootContext | null } = { ctx: null };
    const server = await bootServer(bootInputFor(dir.path, { sitePacks: false }), {
      phases: capturing(seen),
    });
    try {
      expect(seen.ctx?.domain?.strategyState).toBeNull();
    } finally {
      await server.stop();
    }
  });
});
