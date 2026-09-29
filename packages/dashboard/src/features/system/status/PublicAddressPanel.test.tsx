/** @module features/system/status/PublicAddressPanel.test — the public-address card: each check outcome's sentence, the viewed-elsewhere hint, Check again, axe clean */
import { describe, expect, it } from 'bun:test';
import type { PublicUrlStatus } from '@browserhive/contracts/http';
import { expectNoA11yViolations } from '../../../../test/helpers/axe.ts';
import { renderPage } from '../../../../test/helpers/page-harness.tsx';
import { screen } from '../../../../test/helpers/render.tsx';
import {
  OUTCOME_TEXT,
  outcomeSentence,
  PublicAddressPanel,
  viewedElsewhere,
} from './PublicAddressPanel.tsx';

const BASE: PublicUrlStatus = {
  configured: true,
  url: 'https://bh.example.net',
  local_url: 'http://127.0.0.1:9876',
  host_trusted: true,
  outcome: 'ok',
  detail: 'The address answered with this BrowserHive.',
  status_code: 200,
  checked_at: 1_700_000_000_000,
  insecure: false,
};

describe('public address', () => {
  it('uses the server detail, adds the status code once, and explains unset', () => {
    expect(outcomeSentence(BASE)).toBe('The address answered with this BrowserHive. (HTTP 200)');
    expect(outcomeSentence({ ...BASE, detail: 'HTTP 401 answered', status_code: 401 })).toBe(
      'HTTP 401 answered',
    );
    expect(outcomeSentence({ ...BASE, outcome: 'unset', url: null, configured: false })).toBe(
      OUTCOME_TEXT.unset,
    );
  });

  it('notices a dashboard opened at another address', () => {
    expect(viewedElsewhere(BASE, 'http://192.168.1.4:9876')).toBe(true);
    expect(viewedElsewhere(BASE, 'https://bh.example.net')).toBe(false);
    expect(viewedElsewhere(BASE, 'http://127.0.0.1:9876')).toBe(false);
  });

  it('renders each outcome accessibly', async () => {
    for (const outcome of ['ok', 'elsewhere', 'login', 'unreachable'] as const) {
      const view = renderPage({
        path: '/system',
        url: '/system',
        component: PublicAddressPanel,
        routes: { 'GET /system/public-url': { ...BASE, outcome, insecure: outcome === 'login' } },
      });
      await screen.findByText('https://bh.example.net');
      await screen.findByRole('button', { name: /Check again/ });
      await expectNoA11yViolations(view.container);
      view.unmount();
    }
  }, 20_000);
});
