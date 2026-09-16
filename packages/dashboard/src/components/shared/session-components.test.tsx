/** @module components/shared/session-components.test — LeaseBar thresholds/frozen/expired, BulkBar actions + select-all + progress, SessionRef link + copy, UrlCell truncation/credentials, ImageZoomModal zoom + missing state; axe on each */

import { describe, expect, it } from 'bun:test';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { expectNoA11yViolations } from '../../../test/helpers/axe.ts';
import { act, fireEvent, render, screen, waitFor } from '../../../test/helpers/render.tsx';
import { BulkBar } from './bulk-bar.tsx';
import { ImageZoomModal } from './image-zoom-modal.tsx';
import { LeaseBar, leasePercent } from './lease-bar.tsx';
import { SessionRef } from './session-ref.tsx';
import { UrlCell } from './url-cell.tsx';
import { anchoredOffset, clampZoom } from './use-image-zoom.ts';

function inRouter(ui: ReactElement) {
  const root = createRootRoute({ component: () => ui, staticData: { title: 'T' } });
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  return render(<RouterProvider router={router} />);
}

describe('LeaseBar', () => {
  it('uses registry thresholds and a text alternative', async () => {
    const { container, rerender } = render(
      <LeaseBar remainingMs={30 * 60_000} totalMs={60 * 60_000} />,
    );
    const bar = screen.getByRole('progressbar', { name: 'Lease: 30m 00s remaining' });
    expect(bar).toBeDefined();
    expect(container.querySelector('.text-neutral-text')).not.toBeNull();
    await expectNoA11yViolations(container);
    rerender(<LeaseBar remainingMs={5 * 60_000} />);
    expect(container.querySelector('.text-warn-text')).not.toBeNull();
    rerender(<LeaseBar remainingMs={60_000} />);
    expect(container.querySelector('.text-danger-text')).not.toBeNull();
    rerender(<LeaseBar remainingMs={60_000} pausedAt={1} />);
    expect(screen.getByText('frozen · blocked')).toBeDefined();
    rerender(<LeaseBar remainingMs={0} />);
    expect(screen.getByText('expired')).toBeDefined();
    expect(leasePercent(30, 60)).toBe(50);
    expect(leasePercent(120_000)).toBe(100);
  });
});

describe('BulkBar', () => {
  it('renders the count, actions, select-all and clear', async () => {
    const calls: string[] = [];
    const { container, rerender } = render(
      <BulkBar
        count={2}
        total={40}
        actions={[
          { id: 'archive', label: 'Archive', onClick: () => calls.push('archive') },
          { id: 'delete', label: 'Delete…', danger: true, onClick: () => calls.push('delete') },
        ]}
        onSelectAll={() => calls.push('all')}
        onClear={() => calls.push('clear')}
      />,
    );
    expect(screen.getByText('2 selected')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Select all 40 matching' }));
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(calls).toEqual(['all', 'archive', 'clear']);
    await expectNoA11yViolations(container);
    rerender(
      <BulkBar
        count={2}
        actions={[{ id: 'a', label: 'Archive', onClick: () => undefined }]}
        onClear={() => undefined}
        busy
        progress={0.5}
      />,
    );
    expect((screen.getByRole('button', { name: 'Archive' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByRole('progressbar', { name: 'Processing sessions' })).toBeDefined();
  });
});

describe('SessionRef and UrlCell', () => {
  it('links the slug, truncates the id 8/6 and copies via the trailing icon', async () => {
    const { container } = inRouter(
      <div>
        <SessionRef id="checkout-flow-a1b2c3d4" />
        <UrlCell
          url="https://user:pw@example.com/a/very/long/path/that/keeps/going/on/and/on?x=1"
          category="public"
        />
      </div>,
    );
    const link = await screen.findByRole('link', { name: 'checkout-flow' });
    expect(link.getAttribute('href')).toBe('/sessions/checkout-flow-a1b2c3d4');
    expect(screen.getByText('checkout…b2c3d4')).toBeDefined();
    expect(
      screen.getByRole('button', { name: 'Copy session id checkout-flow-a1b2c3d4' }),
    ).toBeDefined();
    const url = container.querySelector(
      '[data-url="https://example.com/a/very/long/path/that/keeps/going/on/and/on?x=1"]',
    );
    if (url === null) throw new Error('url cell missing');
    expect(url.textContent).toContain('…');
    expect(url.textContent).not.toContain('pw@');
    await expectNoA11yViolations(container);
  });
});

describe('ImageZoomModal', () => {
  it('zooms with buttons, clamps and shows the missing state', async () => {
    expect(clampZoom(100)).toBe(8);
    expect(clampZoom(0.01)).toBe(0.25);
    expect(anchoredOffset({ x: 0, y: 0 }, { x: 10, y: 10 }, 1, 2)).toEqual({ x: -10, y: -10 });
    render(
      <ImageZoomModal
        open
        onOpenChange={() => undefined}
        src="/shot.png"
        title="navigate · 10:00:00"
        subtitle="1280×720 · 84 KB"
      />,
    );
    const dialog = await screen.findByRole('dialog');
    expect(screen.getByText('100%')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(screen.getByText('125%')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Fit' }));
    expect(screen.getByText('100%')).toBeDefined();
    expect(screen.getByRole('link', { name: /Open raw/ }).getAttribute('href')).toBe('/shot.png');
    const img = dialog.querySelector('img');
    await act(async () => {
      if (img !== null) fireEvent.error(img);
    });
    await waitFor(() => expect(screen.getByText('Screenshot is no longer on disk')).toBeDefined());
    await expectNoA11yViolations(dialog, { disable: ['aria-hidden-focus'] });
  });
});
