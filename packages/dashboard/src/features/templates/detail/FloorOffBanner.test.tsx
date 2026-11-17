/** @module features/templates/detail/FloorOffBanner.test — a site turned off below its pack's stealth floor (`TEMPLATE_SITE_BELOW_FLOOR`, D-71) on the template page: which site, why, the two ways on (a new template or removing the site, never Settings), the docs link; nothing for another template or a resolved record; axe clean */

import { describe, expect, it } from 'bun:test';
import type { SystemEvent } from '@browserhive/contracts/http';
import { expectNoA11yViolations } from '../../../../test/helpers/axe.ts';
import { render, screen } from '../../../../test/helpers/render.tsx';
import { FloorOffBanner } from './FloorOffBanner.tsx';

function record(resolved_at: number | null = null): SystemEvent {
  return {
    event_id: 'e-floor',
    code: 'TEMPLATE_SITE_BELOW_FLOOR',
    severity: 'error',
    message: 'raw',
    details: {
      pack_id: 'linkedin.com',
      version: 3,
      reason: 'local_override_ended',
      template_ids: ['tp-1'],
      templates: [
        {
          template_id: 'tp-1',
          name: 'sales',
          site_ids: ['linkedin.com'],
          issues: [
            {
              code: 'stealth_below_floor',
              message: "needs stealth 'max' or higher (the template has 'standard')",
            },
          ],
        },
      ],
      templates_text: "'sales' needs stealth 'max' or higher (the template has 'standard')",
    },
    first_seen_at: 1,
    last_seen_at: 1,
    count: 1,
    resolved_at,
  };
}

describe('FloorOffBanner', () => {
  it('says which site was turned off, why, and the ways on; axe clean', async () => {
    const view = render(<FloorOffBanner events={[record()]} templateId="tp-1" />);
    expect(screen.getByText('linkedin.com was turned off')).toBeDefined();
    const text = view.container.textContent ?? '';
    expect(text).toContain('its approved local pack file was removed');
    expect(text).toContain("needs stealth 'max' or higher");
    expect(text).toContain('create a new template with higher stealth');
    expect(text).toContain('or remove the site here');
    expect(text).not.toMatch(/Settings/);
    expect(
      screen
        .getByRole('link', { name: 'When a version raises the stealth floor' })
        .getAttribute('href'),
    ).toContain('#when-a-version-raises-the-stealth-floor');
    await expectNoA11yViolations(view.container);
  });

  it('shows nothing for another template or a resolved record', () => {
    const other = render(<FloorOffBanner events={[record()]} templateId="tp-2" />);
    expect(other.container.textContent).toBe('');
    const resolved = render(<FloorOffBanner events={[record(5)]} templateId="tp-1" />);
    expect(resolved.container.textContent).toBe('');
  });
});
