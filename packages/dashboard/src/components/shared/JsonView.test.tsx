/** @module components/shared/JsonView.test — values render as text nodes; markup in strings never becomes elements */

import { describe, expect, it } from 'bun:test';
import { expectNoA11yViolations } from '../../../test/helpers/axe.ts';
import { render, screen } from '../../../test/helpers/render.tsx';
import { coerceJson, JsonView } from './JsonView.tsx';

describe('JsonView', () => {
  it('never injects HTML from string values', async () => {
    const { container } = render(
      <JsonView
        value={{ a: '<img src=x onerror=alert(1)>', b: [1, true, null], c: { d: { e: 'deep' } } }}
        collapseAt={4}
      />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(screen.getByText('"deep"')).toBeDefined();
    await expectNoA11yViolations(container);
  });

  it('parses JSON strings leniently and collapses deep nodes', () => {
    expect(coerceJson('{"x":1}')).toEqual({ x: 1 });
    expect(coerceJson('not json')).toBe('not json');
    const { container } = render(
      <JsonView value={{ l1: { l2: { l3: 'hidden' } } }} collapseAt={2} copy={false} />,
    );
    expect(container.textContent).not.toContain('"hidden"');
    expect(container.querySelectorAll('button[aria-expanded="false"]').length).toBe(1);
  });
});
