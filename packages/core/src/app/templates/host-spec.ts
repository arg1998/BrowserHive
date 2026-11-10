/** @module app/templates/host-spec — a template host's start specification, from the template record only (spec 13 §2.2, §3.1): the pinned identity, the pinned proxy (credentials from a named variable, resolved at each start) and the host's directories. */

import { join } from 'node:path';
import type { StealthDriver } from '@browserhive/contracts/enums';
import type { AppliedIdentity, ProxySpec } from '../../ports/browser-driver.ts';
import type { ObservedIdentityRecord, TemplateRecord } from '../../ports/persistence/index.ts';
import type { ProxyResolver } from '../../ports/proxy-resolver.ts';
import type { TemplateHostSpec } from '../../ports/template-host.ts';

/** A virtual session's window before the first recording sets one (spec 13 §2.2). */
export const DEFAULT_TEMPLATE_WINDOW = Object.freeze({ width: 1280, height: 800 });

/** What the spec builder needs from the server. */
export interface HostSpecDeps {
  readonly dataDir: string;
  readonly stealthDriver: StealthDriver;
  readonly proxyResolver: ProxyResolver;
  /** The process environment (a proxy's `password_env` is read at each start, D-33). */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** BrowserHive's own origins at this moment (the bound address may be known only after listen). */
  readonly selfOrigins: () => readonly string[];
  /** Chromium switches from the internal testing seam (spec 13 §14). */
  readonly testingArgs: readonly string[];
}

/** `<data-dir>/templates/<id>`. */
export function templateDir(dataDir: string, templateId: string): string {
  return join(dataDir, 'templates', templateId);
}

/** Builds the spec of one host start. */
export async function buildHostSpec(
  template: TemplateRecord,
  deps: HostSpecDeps,
): Promise<TemplateHostSpec> {
  const dir = templateDir(deps.dataDir, template.templateId);
  const identity = template.identity;
  return {
    templateId: template.templateId,
    channel: template.channel,
    headless: template.headless,
    stealth: template.stealth !== 'off',
    fingerprint: template.fingerprint,
    stealthDriver: deps.stealthDriver,
    userDataDir: join(dir, 'userdata'),
    downloadsDir: join(dir, 'downloads'),
    identity: {
      seed: identity.seed,
      geo: {
        locale: identity.locale,
        languages: [...identity.languages],
        countryCode: identity.countryCode,
        timezoneId: identity.timezoneId,
        ...(identity.geolocation !== undefined && { geolocation: { ...identity.geolocation } }),
        source: 'host',
      },
    },
    proxy: await resolveProxy(template, deps),
    window: template.identityObserved?.window ?? DEFAULT_TEMPLATE_WINDOW,
    selfOrigins: deps.selfOrigins(),
    testingArgs: deps.testingArgs,
  };
}

/** The pinned proxy through the `ProxyResolver` (forced loopback bypass, D-13); `null` = none. */
async function resolveProxy(
  template: TemplateRecord,
  deps: HostSpecDeps,
): Promise<ProxySpec | null> {
  const proxy = template.proxy;
  if (proxy === null) return null;
  const password = proxy.passwordEnv === null ? undefined : deps.env[proxy.passwordEnv];
  const requested: ProxySpec = {
    server: proxy.server,
    ...(proxy.bypass !== null && { bypass: proxy.bypass }),
    ...(proxy.username !== null && { username: proxy.username }),
    ...(password !== undefined && { password }),
    label: proxy.label,
    source: 'byo',
  };
  return deps.proxyResolver.resolve({ sessionId: template.templateId, requested });
}

/**
 * The identity a host start observed (spec 13 §2.2), from the applied identity: what the applier
 * does not derive (`platform_version`, `architecture`, `bitness`) is recorded empty, never invented.
 */
export function observedIdentity(
  identity: AppliedIdentity,
  window: { readonly width: number; readonly height: number },
  now: number,
): ObservedIdentityRecord {
  const display = identity.display;
  return {
    chromeMajor: identity.chromeMajor,
    userAgent: identity.userAgent,
    uaCh: {
      brands: identity.brands.map((b) => ({ brand: b.brand, version: b.version })),
      fullVersionList: [],
      platform: identity.platform,
      platformVersion: '',
      architecture: '',
      bitness: '',
    },
    screen: {
      width: display?.screen.width ?? window.width,
      height: display?.screen.height ?? window.height,
      deviceScaleFactor: display?.deviceScaleFactor ?? 1,
    },
    window: { width: window.width, height: window.height },
    observedAt: now,
  };
}

/** What a host start means for the template's observed identity (spec 13 §2.2). */
export type StartObservation =
  | { readonly kind: 'record'; readonly record: ObservedIdentityRecord }
  | { readonly kind: 'drift'; readonly from: string; readonly to: string }
  | null;

/**
 * The first start records the observed identity (from the applied identity, or with stealth off
 * from the browser version only: nothing is invented); a later start whose Chrome major differs is
 * an identity drift; anything else changes nothing.
 */
export function observeStart(
  template: Pick<TemplateRecord, 'identityObserved'>,
  host: {
    readonly identity: AppliedIdentity | null;
    readonly browserInfo?: { readonly version: string | null };
  },
  now: number,
): StartObservation {
  const version = host.browserInfo?.version ?? null;
  const major = host.identity?.chromeMajor ?? version?.split('.')[0] ?? null;
  if (major === null || major === '') return null;
  const observed = template.identityObserved;
  if (observed !== null) {
    return observed.chromeMajor === major
      ? null
      : { kind: 'drift', from: observed.chromeMajor, to: major };
  }
  if (host.identity !== null) {
    return {
      kind: 'record',
      record: observedIdentity(host.identity, DEFAULT_TEMPLATE_WINDOW, now),
    };
  }
  const window = DEFAULT_TEMPLATE_WINDOW;
  return {
    kind: 'record',
    record: {
      chromeMajor: major,
      userAgent: '',
      uaCh: {
        brands: [],
        fullVersionList: [],
        platform: '',
        platformVersion: '',
        architecture: '',
        bitness: '',
      },
      screen: { width: window.width, height: window.height, deviceScaleFactor: 1 },
      window: { width: window.width, height: window.height },
      observedAt: now,
    },
  };
}
