/** @module features/system/config/ConfigTable.test — the reference filter and chips on the table alone (spec 04, spec 08 §3.1), axe clean */
import { describe, expect, it } from 'bun:test';
import { systemConfig } from '../../../../test/fixtures/ops.ts';
import { expectNoA11yViolations } from '../../../../test/helpers/axe.ts';
import { act, fireEvent, render, screen, within } from '../../../../test/helpers/render.tsx';
import { ConfigTable } from './ConfigTable.tsx';

function mount() {
  return render(
    <ConfigTable keys={systemConfig().keys} filter={undefined} onFilterChange={() => undefined} />,
  );
}

function rowKeys(): (string | null)[] {
  const region = screen.getByRole('region', { name: 'Effective configuration' });
  return within(region)
    .getAllByRole('rowheader')
    .map((cell) => cell.textContent);
}

describe('ConfigTable references', () => {
  it('"Only values from references" narrows the table and counts the keys', async () => {
    const view = mount();
    const label = screen.getByText('Only values from references').closest('label');
    if (label === null) throw new Error('switch label missing');
    expect(label.textContent).toContain('(3)');
    expect(rowKeys()).toContain('port');
    const toggle = within(label).getByRole('switch');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    await act(async () => {
      fireEvent.click(label);
    });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(rowKeys()).toEqual(['maxSessions', 'otelEndpoint', 'otelHeaders']);
    await expectNoA11yViolations(view.container);
  });

  it('shows one chip per variable, outlined state in the name when a default was used', () => {
    mount();
    expect(
      screen.getByRole('button', { name: /^\$OTLP_HOST: environment variable, set\./ }),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: /^\$OTLP_TOKEN: environment variable, set\./ }),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: /MAX_SESSIONS/ })).toBeNull();
  });

  it('hides the switch when no value came from references', () => {
    render(
      <ConfigTable
        keys={systemConfig().keys.filter((k) => k.refs === undefined && k.key !== 'maxSessions')}
        filter={undefined}
        onFilterChange={() => undefined}
      />,
    );
    expect(screen.queryByText('Only values from references')).toBeNull();
  });
});
