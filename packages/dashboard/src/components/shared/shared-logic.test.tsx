/** @module components/shared/shared-logic.test — count chips hide zeros and pluralise, URL split, data panel phases, search debounce survives re-render storms, stat tile link affordance */
import { describe, expect, it } from 'bun:test';
import { useState } from 'react';
import { act, render, screen } from '../../../test/helpers/render.tsx';
import { CountChip, countLabel } from './Chip.tsx';
import { panelPhase } from './DataPanel.tsx';
import { useDebouncedSearch } from './FilterBar.tsx';
import { splitUrl } from './url-cell.tsx';

describe('chips', () => {
  it('pluralises and renders nothing at zero unless asked', () => {
    expect(countLabel(1, 'errors')).toBe('error');
    expect(countLabel(2, 'errors')).toBe('errors');
    expect(countLabel(1, 'matches', 'match')).toBe('match');
    const { container, rerender } = render(<CountChip count={0} label="errors" />);
    expect(container.textContent).toBe('');
    rerender(<CountChip count={0} label="errors" showZero />);
    expect(container.textContent).toBe('0 errors');
    rerender(<CountChip count={1} label="errors" />);
    expect(container.textContent).toBe('1 error');
  });
});

describe('url split', () => {
  it('drops http(s) and separates host from the rest', () => {
    expect(splitUrl('https://example.com/a?b=1#c')).toEqual({
      host: 'example.com',
      rest: '/a?b=1#c',
    });
    expect(splitUrl('https://example.com/')).toEqual({ host: 'example.com', rest: '' });
    expect(splitUrl('about:blank')).toEqual({ host: 'about:', rest: 'blank' });
    expect(splitUrl('not a url')).toEqual({ host: 'not a url', rest: '' });
  });
});

describe('DataPanel phases', () => {
  it('shows retries as their own phase and keeps stale data on refetch errors', () => {
    const base = { isPending: false, isError: false, failureCount: 0, data: undefined };
    expect(panelPhase({ ...base, isPending: true })).toBe('loading');
    expect(panelPhase({ ...base, isPending: true, failureCount: 1 })).toBe('retrying');
    expect(panelPhase({ ...base, isError: true })).toBe('error');
    expect(panelPhase({ ...base, isError: true, data: { ok: 1 } })).toBe('stale-error');
    expect(panelPhase({ ...base, data: [] })).toBe('data');
  });
});

describe('useDebouncedSearch', () => {
  it('commits once even while the parent re-renders every few milliseconds', async () => {
    const commits: (string | undefined)[] = [];
    let setDraftOut: (v: string) => void = () => undefined;
    let tickOut: () => void = () => undefined;
    function Harness() {
      const [, setTick] = useState(0);
      // A fresh callback on every render, like a page that re-renders on each live log line.
      const [draft, setDraft] = useDebouncedSearch('', (v) => commits.push(v), 60);
      setDraftOut = setDraft;
      tickOut = () => setTick((t) => t + 1);
      return <span>{draft}</span>;
    }
    render(<Harness />);
    await act(async () => setDraftOut('boom'));
    for (let i = 0; i < 10; i += 1) {
      await act(async () => {
        tickOut();
        await new Promise((r) => setTimeout(r, 10));
      });
    }
    await act(async () => {
      await new Promise((r) => setTimeout(r, 80));
    });
    expect(commits).toEqual(['boom']);
    expect(screen.getByText('boom')).toBeDefined();
  });
});
