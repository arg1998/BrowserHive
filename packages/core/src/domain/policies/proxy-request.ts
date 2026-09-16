/** @module domain/policies/proxy-request — extracts a caller-supplied (BYO) proxy from launch/context options into a ProxySpec (D-13). */

import type { ProxySpec } from '../../ports/browser-driver.ts';

/** Chromium proxy flags a caller may pass raw until a managed proxy layer exists (spec 11 §4). */
export const PROXY_ARG_PREFIXES: readonly string[] = [
  '--proxy-server',
  '--proxy-pac-url',
  '--proxy-bypass-list',
  '--host-resolver-rules',
];

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

function proxyObject(value: unknown): ProxySpec | null {
  if (!isRecord(value)) return null;
  const server = value['server'];
  if (typeof server !== 'string' || server.length === 0) return null;
  const bypass = value['bypass'];
  const username = value['username'];
  const password = value['password'];
  return {
    server,
    ...(typeof bypass === 'string' && { bypass }),
    ...(typeof username === 'string' && { username }),
    ...(typeof password === 'string' && { password }),
    label: proxyLabelFor(server),
    source: 'byo',
  };
}

/** Operator-facing label for a proxy server: its host (and port), never credentials. */
export function proxyLabelFor(server: string): string {
  try {
    const url = new URL(server.includes('://') ? server : `http://${server}`);
    return url.host;
  } catch {
    return server;
  }
}

/**
 * The BYO proxy the caller asked for: `contextOptions.proxy` wins over `launchOptions.proxy`
 * (Playwright applies the context one); raw `--proxy-*` args are reported as a label-only spec so
 * the identity layer knows egress is foreign (spec 11 §2.6 rule 2).
 */
export function requestedProxy(
  launchOptions: Readonly<Record<string, unknown>> | undefined,
  contextOptions: Readonly<Record<string, unknown>> | undefined,
): ProxySpec | null {
  const fromContext = proxyObject(contextOptions?.['proxy']);
  if (fromContext !== null) return fromContext;
  const fromLaunch = proxyObject(launchOptions?.['proxy']);
  if (fromLaunch !== null) return fromLaunch;
  const args = launchOptions?.['args'];
  if (Array.isArray(args)) {
    for (const arg of args) {
      if (typeof arg !== 'string') continue;
      const key = arg.trim().split('=')[0] ?? '';
      if (PROXY_ARG_PREFIXES.includes(key)) {
        const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : '';
        return {
          server: value,
          label: value.length > 0 ? proxyLabelFor(value) : key,
          source: 'byo',
        };
      }
    }
  }
  return null;
}
