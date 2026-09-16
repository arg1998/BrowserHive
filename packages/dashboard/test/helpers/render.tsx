/** @module dashboard/test/helpers/render — RTL `render` inside the provider tree with fake API/socket; DOM registered first */
import '../setup.ts';
import { afterEach } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import type { RenderOptions, RenderResult } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { KeyboardProvider } from '@/app/providers/KeyboardProvider.tsx';
import { QueryProvider } from '@/app/providers/QueryProvider.tsx';
import { ToastProvider } from '@/app/providers/ToastProvider.tsx';
import { ServerClock } from '@/lib/server-now.ts';
import { ThemeProvider } from '@/theme/ThemeProvider.tsx';
import { fakeThemeDom } from './theme-dom.ts';

// Testing Library is CommonJS: Bun evaluates it while linking, i.e. before `setup.ts` registers the DOM.
// A dynamic import after registration keeps `screen` bound to the happy-dom document.
const rtl = await import('@testing-library/react');
/** Re-exports of Testing Library bound to the registered DOM. */
export const { act, fireEvent, screen, waitFor, within } = rtl;
const { cleanup, render: rtlRender } = rtl;
// `findBy*`/`waitFor` give up after 1s by default, which a loaded machine (CI, parallel suites) can
// exceed for a popup or toast; a failing expectation still fails, only later.
rtl.configure({ asyncUtilTimeout: 3000 });

// `afterEach` registered here would only bind to the first file that imports this module (Bun caches
// modules across test files), so every render starts from a clean document instead.
afterEach(() => cleanup());

/** A QueryClient with retries off and no GC surprises. */
export function testQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false },
    },
  });
}

/** Providers most component tests need (no auth/router). */
export function Providers({
  children,
  client,
}: {
  readonly children: ReactNode;
  readonly client?: QueryClient;
}) {
  return (
    <ThemeProvider dom={fakeThemeDom()}>
      <ToastProvider>
        <QueryProvider
          client={client ?? testQueryClient()}
          clock={new ServerClock(() => 1_700_000_000_000)}
        >
          <KeyboardProvider>{children}</KeyboardProvider>
        </QueryProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}

/** Render with providers. */
export function render(
  ui: ReactElement,
  options: RenderOptions & { readonly client?: QueryClient } = {},
): RenderResult {
  const { client, ...rest } = options;
  cleanup();
  return rtlRender(ui, {
    wrapper: ({ children }) => (
      <Providers {...(client !== undefined && { client })}>{children}</Providers>
    ),
    ...rest,
  });
}
