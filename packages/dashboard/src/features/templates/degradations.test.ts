/** @module features/templates/degradations.test — template degradations read without internal terms: the template they name, the sentence, the key problem of one template */
import { describe, expect, it } from 'bun:test';
import type { SystemEvent } from '@browserhive/contracts/http';
import { keyProblemOf, templateDegradationText, templatesOf } from './degradations.ts';

const event = (code: string, details: unknown, resolved_at: number | null = null): SystemEvent => ({
  event_id: `e-${code}`,
  code,
  severity: 'error',
  message: 'raw',
  details,
  first_seen_at: 1,
  last_seen_at: 1,
  count: 1,
  resolved_at,
});

describe('template degradations', () => {
  it('finds the template a degradation names', () => {
    expect(templatesOf(event('TEMPLATE_HOST_FAILED', { template_id: 'tp-1' }))).toEqual(['tp-1']);
    expect(templatesOf(event('TEMPLATE_KEY_MISSING', { template_ids: ['tp-1', 'tp-2'] }))).toEqual([
      'tp-1',
      'tp-2',
    ]);
    expect(templatesOf(event('DB_SLOW', { template_id: 'tp-1' }))).toEqual([]);
  });

  it('says what happened in plain words, by display name', () => {
    const text = templateDegradationText(
      event('TEMPLATE_HOST_FAILED', { template_id: 'tp-1', reason: 'no_display' }),
      'Job hunt',
    );
    expect(text).toBe(
      'The browser of Job hunt could not start: there is no screen on this machine.',
    );
    expect(text).not.toContain('host');
    expect(templateDegradationText(event('OTHER', {}), 'x')).toBeNull();
  });

  it('returns the open key problem of one template only', () => {
    const events = [
      event('TEMPLATE_KEY_MISMATCH', { template_id: 'tp-2', versions: [3] }),
      event('TEMPLATE_KEY_MISSING', { template_ids: ['tp-1'] }, 5),
    ];
    expect(keyProblemOf(events, 'tp-2')?.code).toBe('TEMPLATE_KEY_MISMATCH');
    expect(keyProblemOf(events, 'tp-1')).toBeNull();
  });
});
