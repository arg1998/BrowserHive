/** @module components/shared/DataTable.test — sort gating, select-all tri-state, j/k/Enter, whole-row links (real anchors, plain vs modified clicks), row clicks that ignore inline controls, expand on row click, hover-revealed cells, pager hidden when one page fits, skeleton rows, cards */

import { describe, expect, it } from 'bun:test';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { expectNoA11yViolations } from '../../../test/helpers/axe.ts';
import { act, fireEvent, render, screen, waitFor, within } from '../../../test/helpers/render.tsx';
import { DataTable } from './DataTable.tsx';
import { pagerNeeded } from './Pagination.tsx';
import { UrlCell } from './url-cell.tsx';
import type { DataTableColumn } from './use-data-table.ts';

interface Row extends Record<string, unknown> {
  readonly id: string;
  readonly name: string;
}

const rows: Row[] = [
  { id: 'a', name: 'alpha' },
  { id: 'b', name: 'beta' },
  { id: 'c', name: 'gamma' },
];
const columns: DataTableColumn<Row>[] = [
  { id: 'name', header: 'Name', cell: (r) => r.name, sortable: true },
  { id: 'id', header: 'Id', cell: (r) => r.id, sortable: true, priority: 2, mono: true },
];

function inRouter(ui: ReactElement) {
  const root = createRootRoute({ staticData: { title: 'T' } });
  const list = createRoute({
    getParentRoute: () => root,
    path: '/',
    component: () => ui,
    staticData: { title: 'List' },
  });
  const item = createRoute({
    getParentRoute: () => root,
    path: '/items/$id',
    component: () => <p>item page</p>,
    staticData: { title: 'Item' },
  });
  const router = createRouter({
    routeTree: root.addChildren([list, item]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  return { router, view: render(<RouterProvider router={router} />) };
}

describe('DataTable', () => {
  it('renders sortable headers only for whitelisted keys and cycles aria-sort', async () => {
    const patches: unknown[] = [];
    const { container } = render(
      <DataTable
        label="Rows"
        columns={columns}
        rows={rows}
        rowCount={3}
        state={{ page: 1, pageSize: 25, sort: 'name', dir: 'desc' }}
        sortKeys={['name']}
        getRowId={(r) => r.id}
        onStateChange={(p) => patches.push(p)}
        emptyState={<p>none</p>}
      />,
    );
    const headers = screen.getAllByRole('columnheader');
    expect(headers[0]?.getAttribute('aria-sort')).toBe('descending');
    expect(headers[1]?.getAttribute('aria-sort')).toBeNull();
    fireEvent.click(within(headers[0] as HTMLElement).getByRole('button'));
    expect(patches).toEqual([{ sort: 'name', dir: 'asc' }]);
    await expectNoA11yViolations(container);
  });

  it('marks the column that displays an aliased sort key (sort=errors on Activity)', () => {
    const aliased: readonly DataTableColumn<Row>[] = [
      {
        id: 'name',
        header: 'Name',
        cell: (r) => r.name,
        sortable: true,
        sortAliases: { errors: 'errors' },
      },
      { id: 'id', header: 'Id', cell: (r) => r.id, sortable: true },
    ];
    render(
      <DataTable
        label="Rows"
        columns={aliased}
        rows={rows}
        rowCount={3}
        state={{ page: 1, pageSize: 25, sort: 'errors', dir: 'desc' }}
        sortKeys={['name', 'id', 'errors']}
        getRowId={(r) => r.id}
        onStateChange={() => undefined}
        emptyState={<p>none</p>}
      />,
    );
    const headers = screen.getAllByRole('columnheader');
    expect(headers[0]?.getAttribute('aria-sort')).toBe('descending');
    expect(headers[0]?.textContent).toContain('errors');
    expect(headers[1]?.getAttribute('aria-sort')).toBe('none');
  });

  it('shows a tri-state select-all checkbox and reports ids', async () => {
    const patches: { sel?: readonly string[] }[] = [];
    const view = render(
      <DataTable
        label="Rows"
        columns={columns}
        rows={rows}
        rowCount={3}
        state={{ page: 1, pageSize: 25, selection: new Set(['a']) }}
        getRowId={(r) => r.id}
        onStateChange={(p) => patches.push(p)}
        emptyState={<p>none</p>}
      />,
    );
    const all = screen.getByRole('checkbox', { name: 'Select all rows on this page' });
    expect(all.getAttribute('aria-checked')).toBe('mixed');
    await act(async () => {
      fireEvent.click(all);
    });
    expect(new Set(patches.at(-1)?.sel)).toEqual(new Set(['a', 'b', 'c']));
    view.rerender(
      <DataTable
        label="Rows"
        columns={columns}
        rows={rows}
        rowCount={3}
        state={{ page: 1, pageSize: 25, selection: new Set(['a', 'b', 'c']) }}
        getRowId={(r) => r.id}
        onStateChange={(p) => patches.push(p)}
        emptyState={<p>none</p>}
      />,
    );
    expect(
      screen
        .getByRole('checkbox', { name: 'Select all rows on this page' })
        .getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('moves with j/k and opens with Enter inside the focused region', () => {
    const opened: string[] = [];
    render(
      <DataTable
        label="Rows"
        columns={columns}
        rows={rows}
        rowCount={3}
        state={{ page: 1, pageSize: 25 }}
        getRowId={(r) => r.id}
        onStateChange={() => undefined}
        onRowOpen={(r) => opened.push(r.id)}
        emptyState={<p>none</p>}
      />,
    );
    const region = screen.getByRole('region', { name: 'Rows' });
    fireEvent.keyDown(region, { key: 'j' });
    fireEvent.keyDown(region, { key: 'j' });
    fireEvent.keyDown(region, { key: 'k' });
    fireEvent.keyDown(region, { key: 'Enter' });
    expect(opened).toEqual(['b']);
  });

  it('makes the whole row a real link: plain clicks navigate in-app, modified clicks are left to the browser', async () => {
    const { router, view } = inRouter(
      <DataTable
        label="Rows"
        columns={columns}
        rows={rows}
        state={{ page: 1, pageSize: 25 }}
        getRowId={(r) => r.id}
        onStateChange={() => undefined}
        rowHref={(r) => `/items/${r.id}`}
        rowLabel={(r) => `Open ${r.name}`}
        emptyState={<p>none</p>}
      />,
    );
    const link = await screen.findByRole('link', { name: 'Open beta' });
    expect(link.getAttribute('href')).toBe('/items/b');
    expect(link.closest('tr')?.hasAttribute('data-row-link-scope')).toBe(true);
    const modified = new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true });
    link.dispatchEvent(modified);
    expect(modified.defaultPrevented).toBe(false);
    expect(router.state.location.pathname).toBe('/');
    await act(async () => {
      fireEvent.click(link);
    });
    await waitFor(() => expect(router.state.location.pathname).toBe('/items/b'));
    expect(view.container.textContent).toContain('item page');
  });

  it('fires onRowClick anywhere in the row except on inline controls', async () => {
    const clicked: string[] = [];
    const pressed: string[] = [];
    const withButton: DataTableColumn<Row>[] = [
      ...columns,
      {
        id: 'actions',
        header: 'Actions',
        hideHeader: true,
        revealOnHover: true,
        cell: (r) => (
          <button type="button" onClick={() => pressed.push(r.id)}>
            Act on {r.name}
          </button>
        ),
      },
    ];
    render(
      <DataTable
        label="Rows"
        columns={withButton}
        rows={rows}
        state={{ page: 1, pageSize: 25 }}
        getRowId={(r) => r.id}
        onStateChange={() => undefined}
        onRowClick={(r) => clicked.push(r.id)}
        emptyState={<p>none</p>}
      />,
    );
    fireEvent.click(screen.getByText('gamma'));
    const button = screen.getByRole('button', { name: 'Act on alpha' });
    fireEvent.click(button);
    expect(clicked).toEqual(['c']);
    expect(pressed).toEqual(['a']);
    expect(button.closest('.reveal')).not.toBeNull();
    expect(screen.getByRole('columnheader', { name: 'Actions' })).toBeDefined();
  });

  it('expands a row on click with a rotating chevron', () => {
    const toggled: string[] = [];
    render(
      <DataTable
        label="Rows"
        columns={columns}
        rows={rows}
        state={{ page: 1, pageSize: 25 }}
        getRowId={(r) => r.id}
        onStateChange={() => undefined}
        expandable={(r) => <p>detail of {r.name}</p>}
        expanded={new Set(['a'])}
        onToggleExpanded={(r) => toggled.push(r.id)}
        emptyState={<p>none</p>}
      />,
    );
    expect(screen.getByText('detail of alpha')).toBeDefined();
    const rowA = screen.getByText('alpha').closest('tr');
    expect(rowA?.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(screen.getByText('beta'));
    expect(toggled).toEqual(['b']);
  });

  it('hides the pager when one page fits, and keeps it for out-of-range pages', () => {
    expect(pagerNeeded(1, 25, 3, false)).toBe(false);
    expect(pagerNeeded(1, 25, 0, undefined)).toBe(false);
    expect(pagerNeeded(1, 25, undefined, true)).toBe(true);
    expect(pagerNeeded(1, 25, 60, undefined)).toBe(true);
    expect(pagerNeeded(4, 25, 60, undefined)).toBe(true);
    const patches: { page?: number }[] = [];
    render(
      <DataTable
        label="Rows"
        columns={columns}
        rows={rows}
        rowCount={60}
        state={{ page: 9, pageSize: 25 }}
        getRowId={(r) => r.id}
        onStateChange={(p) => patches.push(p)}
        emptyState={<p>none</p>}
      />,
    );
    const pager = screen.getByRole('navigation', { name: 'Pagination' });
    expect(pager.textContent).toContain('3 / 3');
    expect((screen.getByRole('button', { name: 'Next page' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    expect(patches).toEqual([{ page: 2 }]);
    render(
      <DataTable
        label="Empty"
        columns={columns}
        rows={[]}
        rowCount={0}
        state={{ page: 1, pageSize: 25 }}
        getRowId={(r) => r.id}
        onStateChange={() => undefined}
        emptyState={<p>none</p>}
      />,
    );
    expect(screen.getByText('none')).toBeDefined();
    expect(screen.queryByRole('navigation', { name: 'Pagination' })).toBeNull();
  });

  it('renders skeleton rows at the density row height while loading', () => {
    const { container } = render(
      <DataTable
        label="Rows"
        columns={columns}
        rows={[]}
        state={{ page: 1, pageSize: 25 }}
        getRowId={(r) => r.id}
        onStateChange={() => undefined}
        loading
        density="compact"
        emptyState={<p>none</p>}
      />,
    );
    expect(screen.getByRole('status', { name: 'Loading' })).toBeDefined();
    expect(container.querySelectorAll('.h-9').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('.h-11').length).toBe(0);
  });

  it('renders cards under md when renderCard is given', () => {
    render(
      <DataTable
        label="Rows"
        columns={columns}
        rows={rows}
        state={{ page: 1, pageSize: 25 }}
        getRowId={(r) => r.id}
        onStateChange={() => undefined}
        emptyState={<p>none</p>}
        renderCard={(r) => <span>{r.name} card</span>}
      />,
    );
    expect(screen.getByText('alpha card')).toBeDefined();
  });

  it('uses grid roles for rows with aria-expanded / aria-selected and passes axe unmodified', async () => {
    const { container } = render(
      <>
        <DataTable
          label="Expandable"
          columns={columns}
          rows={rows}
          state={{ page: 1, pageSize: 25 }}
          getRowId={(r) => r.id}
          onStateChange={() => undefined}
          expandable={(r) => <p>detail of {r.name}</p>}
          expanded={new Set(['a'])}
          onToggleExpanded={() => undefined}
          emptyState={<p>none</p>}
        />
        <DataTable
          label="Selectable"
          columns={columns}
          rows={rows}
          state={{ page: 1, pageSize: 25, selection: new Set(['b']) }}
          getRowId={(r) => r.id}
          onStateChange={() => undefined}
          emptyState={<p>none</p>}
        />
      </>,
    );
    const tables = container.querySelectorAll('table');
    expect(tables[0]?.getAttribute('role')).toBe('treegrid');
    expect(tables[1]?.getAttribute('role')).toBe('grid');
    await expectNoA11yViolations(container);
  });

  it('keeps one tab stop per row: row checkboxes, copy and open-URL buttons leave the tab order', async () => {
    const withUrl: DataTableColumn<Row>[] = [
      ...columns,
      {
        id: 'url',
        header: 'URL',
        grow: true,
        cell: (r) => <UrlCell url={`https://example.com/${r.id}`} />,
      },
    ];
    inRouter(
      <DataTable
        label="Rows"
        columns={withUrl}
        rows={rows}
        state={{ page: 1, pageSize: 25, selection: new Set() }}
        getRowId={(r) => r.id}
        onStateChange={() => undefined}
        rowHref={(r) => `/items/${r.id}`}
        emptyState={<p>none</p>}
      />,
    );
    const region = await screen.findByRole('region', { name: 'Rows' });
    const tabbable = [
      ...region.querySelectorAll<HTMLElement>('tbody [tabindex], tbody a[href], tbody button'),
    ].filter((el) => el.tabIndex >= 0);
    // Only the roving row itself.
    expect(tabbable.map((el) => el.tagName)).toEqual(['TR']);
    expect(within(region).getAllByRole('button', { name: 'Copy URL' })[0]?.tabIndex).toBe(-1);
  });

  it('renders URL text in a linked row as plain text under the row link', async () => {
    const withUrl: DataTableColumn<Row>[] = [
      ...columns,
      {
        id: 'url',
        header: 'URL',
        grow: true,
        cell: (r) => <UrlCell url={`https://example.com/${r.id}`} />,
      },
    ];
    inRouter(
      <DataTable
        label="Rows"
        columns={withUrl}
        rows={rows}
        state={{ page: 1, pageSize: 25 }}
        getRowId={(r) => r.id}
        onStateChange={() => undefined}
        rowHref={(r) => `/items/${r.id}`}
        emptyState={<p>none</p>}
      />,
    );
    const region = await screen.findByRole('region', { name: 'Rows' });
    const text = region.querySelector<HTMLElement>('[data-url="https://example.com/a"]');
    expect(text).not.toBeNull();
    // Not a tooltip trigger, not lifted: nothing between the pointer and the row link.
    expect(text?.hasAttribute('data-popup-open')).toBe(false);
    expect(text?.closest('[data-interactive], a, button')).toBeNull();
    // The actions group is lifted explicitly and has no transform that would trap it.
    const actions = text?.parentElement?.querySelector('[data-interactive]');
    expect(actions?.className).not.toContain('translate');
  });

  it('opens the focused row menu with Shift+F10', () => {
    const opened: string[] = [];
    const withMenu: DataTableColumn<Row>[] = [
      ...columns,
      {
        id: 'actions',
        header: 'Actions',
        hideHeader: true,
        revealOnHover: true,
        cell: (r) => (
          <button type="button" aria-haspopup="menu" onClick={() => opened.push(r.id)}>
            Actions for {r.name}
          </button>
        ),
      },
    ];
    render(
      <DataTable
        label="Rows"
        columns={withMenu}
        rows={rows}
        state={{ page: 1, pageSize: 25 }}
        getRowId={(r) => r.id}
        onStateChange={() => undefined}
        emptyState={<p>none</p>}
      />,
    );
    const row = screen.getByText('beta').closest('tr') as HTMLElement;
    fireEvent.keyDown(row, { key: 'F10' });
    fireEvent.keyDown(row, { key: 'F10', shiftKey: true });
    expect(opened).toEqual(['b']);
  });
});
