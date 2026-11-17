/** @module app/templates/host-display.test — a headed host on Linux without `DISPLAY`/`WAYLAND_DISPLAY` fails as `no_display` before a browser is launched (spec 13 §3.11, D29); headless hosts, macOS and Windows are unchanged. */

import { describe, expect, it } from 'bun:test';
import { CollectingLogger } from '../../../test/helpers/collecting-logger.ts';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { RecordingDegradations } from '../../../test/helpers/template-kit.ts';
import { templateRecord } from '../../../test/persistence/helpers.ts';
import { isAppError } from '../../kernel/errors/app-error.ts';
import type { TemplateHostLauncher } from '../../ports/template-host.ts';
import { assertDisplay, displayMissing, NO_DISPLAY_MESSAGE } from './host-display.ts';
import { HostLifecycle } from './host-lifecycle.ts';
import { buildHostSpec, type HostSpecDeps } from './host-spec.ts';
import { permanentFailure } from './host-state.ts';

function deps(platform: string | undefined, env: Record<string, string>): HostSpecDeps {
  return {
    dataDir: '/data',
    proxyResolver: { resolve: async (r) => r.requested },
    env,
    selfOrigins: () => [],
    testingArgs: [],
    ...(platform !== undefined && { platform }),
  };
}

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => null,
    (err: unknown) => err,
  );
}

describe('displayMissing', () => {
  it('on Linux needs DISPLAY or WAYLAND_DISPLAY, set and not blank', () => {
    expect(displayMissing('linux', {})).toBe(true);
    expect(displayMissing('linux', { DISPLAY: '' })).toBe(true);
    expect(displayMissing('linux', { DISPLAY: '  ', WAYLAND_DISPLAY: '' })).toBe(true);
    expect(displayMissing('linux', { DISPLAY: ':99' })).toBe(false);
    expect(displayMissing('linux', { WAYLAND_DISPLAY: 'wayland-0' })).toBe(false);
  });

  it('is never missing on macOS or Windows', () => {
    expect(displayMissing('darwin', {})).toBe(false);
    expect(displayMissing('win32', {})).toBe(false);
  });
});

describe('a host start without a display (D29)', () => {
  it('a headed template on Linux fails as no_display, which makes the host failed', async () => {
    const err = await failureOf(
      buildHostSpec(templateRecord({ headless: false }), deps('linux', {})),
    );
    expect(isAppError(err) && err.code).toBe('INTERNAL_ERROR');
    expect(isAppError(err) && err.details).toMatchObject({ ref: 'no_display' });
    expect(err instanceof Error && err.message).toBe(NO_DISPLAY_MESSAGE);
    expect(permanentFailure(err)).toBe('no_display');
  });

  it('a headless template, a display, macOS, Windows and an unknown platform start as before', async () => {
    const headed = templateRecord({ headless: false });
    const cases: [ReturnType<typeof templateRecord>, HostSpecDeps][] = [
      [templateRecord({ headless: true }), deps('linux', {})],
      [headed, deps('linux', { DISPLAY: ':0' })],
      [headed, deps('linux', { WAYLAND_DISPLAY: 'wayland-1' })],
      [headed, deps('darwin', {})],
      [headed, deps('win32', {})],
      [headed, deps(undefined, {})],
    ];
    for (const [template, d] of cases) {
      const spec = await buildHostSpec(template, d);
      expect(spec.templateId).toBe(template.templateId);
    }
  });

  it('assertDisplay refuses only a headed template, with the ref the lifecycle classifies', () => {
    expect(() => assertDisplay({ headless: false }, 'linux', {})).toThrow(NO_DISPLAY_MESSAGE);
    expect(() => assertDisplay({ headless: true }, 'linux', {})).not.toThrow();
    try {
      assertDisplay({ headless: false }, 'linux', {});
    } catch (err) {
      expect(isAppError(err) && err.details).toEqual({ ref: 'no_display' });
    }
  });

  it('the host becomes failed (no_display) without launching a browser; agents get TEMPLATE_DISABLED', async () => {
    let launches = 0;
    const launcher = {
      launchTemplateHost: async () => {
        launches += 1;
        throw new Error('never launched');
      },
    } as unknown as TemplateHostLauncher;
    const degradations = new RecordingDegradations();
    const template = templateRecord({ headless: false });
    const lifecycle = new HostLifecycle(template, {
      launcher,
      clock: new FakeClock(),
      logger: new CollectingLogger(),
      degradations,
      buildSpec: (record) => buildHostSpec(record, deps('linux', {})),
      started: () => undefined,
      closeSessions: async () => undefined,
      slotFree: () => true,
      closeTimeoutMs: 1_000,
    });
    lifecycle.reserve(() => undefined);
    const err = await failureOf(lifecycle.acquire(new AbortController().signal));
    expect(launches).toBe(0);
    expect(lifecycle.state).toBe('failed');
    expect(lifecycle.failure).toBe('no_display');
    expect(lifecycle.lastError).toBe(NO_DISPLAY_MESSAGE);
    expect(isAppError(err) && err.code).toBe('TEMPLATE_DISABLED');
    expect(isAppError(err) && err.details).toMatchObject({ reason: 'needs_operator' });
    expect(degradations.reports[0]?.details).toMatchObject({ reason: 'no_display' });
  });
});
