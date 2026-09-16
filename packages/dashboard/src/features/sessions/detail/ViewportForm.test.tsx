/** @module features/sessions/detail/ViewportForm.test — inline validation messages with aria wiring, preset submit, not-gated warning, axe */

import { describe, expect, it } from 'bun:test';
import { expectNoA11yViolations } from '../../../../test/helpers/axe.ts';
import { act, fireEvent, render, screen } from '../../../../test/helpers/render.tsx';
import { pickOption } from '../../../../test/helpers/select.ts';
import { ViewportForm } from './ViewportForm.tsx';

describe('ViewportForm', () => {
  it('validates bounds inline, submits valid sizes and presets', async () => {
    const sizes: { width: number; height: number }[] = [];
    const { container } = render(
      <ViewportForm onSubmit={(s) => sizes.push(s)} screen={{ width: 2560, height: 1440 }} />,
    );
    expect(screen.getByText("Changes the agent's real viewport")).toBeDefined();
    const width = screen.getByLabelText('width');
    const height = screen.getByLabelText('height');
    fireEvent.change(width, { target: { value: '100' } });
    fireEvent.change(height, { target: { value: '720' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Resize' }));
    });
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe('Enter a whole number between 200 and 10000.');
    expect(width.getAttribute('aria-invalid')).toBe('true');
    expect(width.getAttribute('aria-describedby')).toBe(alert.id);
    expect(sizes).toHaveLength(0);
    await expectNoA11yViolations(container);
    fireEvent.change(width, { target: { value: '1280' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Resize' }));
    });
    expect(sizes).toEqual([{ width: 1280, height: 720 }]);
    await pickOption(screen.getByLabelText('Preset'), /2560 × 1440/);
    expect(sizes[1]).toEqual({ width: 2560, height: 1440 });
  });
});
