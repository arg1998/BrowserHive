/** @module features/sessions/activity/ActivityDetail.test — Parameters: the JSON tree, or for arguments truncated when recorded (D-47) a note with the full size and the kept start as text */

import { describe, expect, it } from 'bun:test';
import { expectNoA11yViolations } from '../../../../test/helpers/axe.ts';
import { render } from '../../../../test/helpers/render.tsx';
import { Parameters, truncatedArgs } from './ActivityDetail.tsx';

const marker = {
  _truncated: true,
  bytes: 4 * 1024 * 1024 + 40,
  preview: `{"session_id":"shop-00000001","text":"${'a'.repeat(200)}`,
} as const;

describe('Parameters', () => {
  it('recognizes only the exact truncation marker', () => {
    expect(truncatedArgs(marker)).toEqual(marker);
    expect(truncatedArgs({ url: 'https://example.com' })).toBeNull();
    expect(truncatedArgs({ ...marker, extra: 1 })).toBeNull();
    expect(truncatedArgs({ ...marker, _truncated: 'yes' })).toBeNull();
    expect(truncatedArgs(null)).toBeNull();
  });

  it('shows truncated parameters as a note and the kept start as text', async () => {
    const { container } = render(<Parameters args={marker} />);
    expect(container.textContent).toContain(
      'Truncated when recorded: the parameters were 4.0 MB, over the 64.0 KB limit.',
    );
    const pre = container.querySelector('pre');
    expect(pre?.textContent).toBe(marker.preview);
    expect(container.textContent).not.toContain('_truncated');
    await expectNoA11yViolations(container);
  });

  it('shows ordinary parameters as a JSON tree, and says when there are none', () => {
    const tree = render(<Parameters args={{ url: 'https://example.com' }} />);
    expect(tree.container.textContent).toContain('"https://example.com"');
    expect(tree.container.textContent).not.toContain('Truncated');
    tree.unmount();
    const empty = render(<Parameters args={{}} />);
    expect(empty.container.textContent).toContain('No parameters.');
  });
});
