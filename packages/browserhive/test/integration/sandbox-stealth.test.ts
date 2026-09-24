/** @module test/integration/sandbox-stealth.test — through BrowserHive, per installed channel: `sandbox=auto` never fails a launch, page-visible stealth signals are identical with and without the sandbox (plan §6), and a required sandbox the host cannot give fails typed, never `INTERNAL_ERROR`. Channels that are not installed skip with a stated reason. */

import { beforeAll, describe, expect, it } from 'bun:test';
import { type ProbeRow, parityProblems, runMatrix } from '../stealth/probe.ts';

const TIMEOUT_MS = 240_000;
let rows: ProbeRow[] = [];

beforeAll(async () => {
  rows = await runMatrix({
    channels: ['chromium', 'chrome', 'edge'],
    stealth: ['standard'],
    sandbox: ['config:off', 'config:auto', 'session'],
  });
  for (const row of rows) {
    if (row.outcome === 'skipped') {
      // Stated, never silently passed: the channel's browser is not installed on this host.
      process.stderr.write(
        `sandbox-stealth: ${row.channel} skipped (${row.sandbox}): ${row.errorCode}: ${row.errorMessage}\n`,
      );
    }
  }
}, TIMEOUT_MS);

describe('sandbox and stealth parity through BrowserHive', () => {
  it('the bundled Chromium is always measured (never skipped)', () => {
    expect(rows.filter((r) => r.channel === 'chromium' && r.outcome === 'skipped')).toEqual([]);
  });

  it('sandbox=auto never fails a launch', () => {
    const auto = rows.filter((r) => r.sandbox === 'config:auto' && r.outcome !== 'skipped');
    expect(auto.length).toBeGreaterThan(0);
    for (const row of auto)
      expect({ channel: row.channel, outcome: row.outcome }).toEqual({
        channel: row.channel,
        outcome: 'launched',
      });
  });

  it('sandbox=off launches exactly as before: unsandboxed', () => {
    for (const row of rows.filter((r) => r.sandbox === 'config:off' && r.outcome === 'launched')) {
      expect({ channel: row.channel, sandboxed: row.sandboxed }).toEqual({
        channel: row.channel,
        sandboxed: false,
      });
    }
  });

  it('every launched session passes the page-visible stealth checks', () => {
    for (const row of rows.filter((r) => r.outcome === 'launched')) {
      expect({ channel: row.channel, sandbox: row.sandbox, problems: row.problems }).toEqual({
        channel: row.channel,
        sandbox: row.sandbox,
        problems: [],
      });
    }
  });

  it('sandboxed and unsandboxed sessions report identical page-visible signals', () => {
    expect(parityProblems(rows)).toEqual([]);
  });

  it('a required sandbox either works or fails as SANDBOX_UNAVAILABLE, retryable never', () => {
    for (const row of rows.filter((r) => r.sandbox === 'session' && r.outcome !== 'skipped')) {
      if (row.outcome === 'launched') {
        expect({ channel: row.channel, sandboxed: row.sandboxed }).toEqual({
          channel: row.channel,
          sandboxed: true,
        });
      } else {
        expect({ code: row.errorCode, retryable: row.retryable }).toEqual({
          code: 'SANDBOX_UNAVAILABLE',
          retryable: 'never',
        });
      }
    }
  });
});
