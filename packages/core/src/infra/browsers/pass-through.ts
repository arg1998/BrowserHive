/** @module infra/browsers/pass-through — validated Playwright launch/context option pass-through, sibling-field policy and BYO-proxy detection (spec 11 §4, §11). */

import type { BrowserContextOptions, LaunchOptions } from 'playwright';
import { z } from 'zod';
import { assertLaunchArgsAllowed } from '../../kernel/deny-list.ts';
import { AppError } from '../../kernel/errors/app-error.ts';
import type { ProxySpec } from '../../ports/browser-driver.ts';

/**
 * BrowserHive does not attempt to re-type Playwright's large, evolving `LaunchOptions` /
 * `BrowserContextOptions` surface. Instead these schemas accept any keys they do not explicitly know
 * about, so new Playwright options work without a BrowserHive release — while a handful of fields we
 * *do* act on (`args`, `executablePath`, `proxy`) are typed so the launch path can reason about them.
 *
 * Safety is layered on top separately:
 *   - `args[]` entries are checked against the deny-list (`kernel/deny-list.ts`) before any browser
 *     is spawned.
 *   - `executablePath` is allowed but flagged: overriding it means channel routing no longer applies.
 *   - `chromiumSandbox: false`, `env`, `downloadsPath` and `recordVideo` bypass the *intent* of the
 *     deny-list through loose fields, so {@link assertLaunchOptionsAllowed} refuses them
 *     (`UNSAFE_LAUNCH_ARG` naming the field).
 *   - `userDataDir` collisions with managed persistence are rejected structurally, handled where
 *     persistence mode is resolved.
 */

/** Playwright's structured `proxy` option (the BYO route). */
export const ProxyOptionSchema = z.object({
  server: z.string().min(1),
  bypass: z.string().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
});

/**
 * Subset of Playwright `LaunchOptions` we type explicitly; everything else passes through.
 * `z.looseObject` is Zod 4's forward-compat "allow unknown keys" object.
 */
export const LaunchOptionsSchema = z.looseObject({
  /** Extra Chromium `--flag` args. Deny-list enforced. Merged after channel args. */
  args: z.array(z.string()).optional(),
  /** Override the browser binary. Allowed but warned; disables channel routing. */
  executablePath: z.string().optional(),
  /** BYO proxy at launch level. Normalised into `LaunchSpec.proxy` by {@link extractByoProxy}. */
  proxy: ProxyOptionSchema.optional(),
  /** Suppress Playwright default args; merged with the stealth rule in `launch-args.ts`. */
  ignoreDefaultArgs: z.union([z.boolean(), z.array(z.string())]).optional(),
});

/** Parsed launch pass-through (known fields typed, the rest `unknown`). */
export type ParsedLaunchOptions = z.infer<typeof LaunchOptionsSchema>;

/**
 * `BrowserContextOptions` pass-through. Only `proxy`, `viewport`, `locale`, `timezoneId` are
 * load-bearing (identity coherence rules); the whole object is forwarded to `newContext(...)` /
 * `launchPersistentContext(...)` verbatim.
 */
export const BrowserContextOptionsSchema = z.looseObject({
  proxy: ProxyOptionSchema.optional(),
  viewport: z.object({ width: z.number(), height: z.number() }).nullable().optional(),
  locale: z.string().optional(),
  timezoneId: z.string().optional(),
});

/** Parsed context pass-through (known fields typed, the rest `unknown`). */
export type ParsedContextOptions = z.infer<typeof BrowserContextOptionsSchema>;

/**
 * Validate a raw `launch_options` payload and hand it over as Playwright's own type.
 *
 * The one `as` in this module is the type boundary of a deliberately forward-compatible
 * pass-through: zod has verified every field BrowserHive acts on, and the remaining keys are by
 * design whatever Playwright accepts (spec 11 §11 "BYO works today with zero code").
 *
 * @throws `UNSAFE_LAUNCH_ARG` (via {@link assertLaunchOptionsAllowed}) and zod errors for bad shapes.
 */
export function parseLaunchOptions(input: unknown): LaunchOptions {
  const parsed = LaunchOptionsSchema.parse(input);
  assertLaunchOptionsAllowed(parsed);
  return parsed as LaunchOptions;
}

/**
 * Validate a raw `context_options` payload and hand it over as Playwright's own type. Same boundary
 * rule as {@link parseLaunchOptions}.
 *
 * @throws `UNSAFE_LAUNCH_ARG` for `recordVideo`.
 */
export function parseContextOptions(input: unknown): BrowserContextOptions {
  const parsed = BrowserContextOptionsSchema.parse(input);
  if (parsed['recordVideo'] !== undefined) throw unsafeField('recordVideo');
  return parsed as BrowserContextOptions;
}

/** Loose launch-option fields that would bypass the intent of the deny-list. */
export const UNSAFE_LAUNCH_OPTION_FIELDS: readonly string[] = [
  'env',
  'downloadsPath',
  'recordVideo',
];

/**
 * Refuse deny-listed `args` and the sibling loose fields (`chromiumSandbox: false`, `env`,
 * `downloadsPath`, `recordVideo`) that bypass the deny-list's intent — a correctness fix, not a
 * behavior an agent could rely on (spec 11 §4).
 *
 * @throws `UNSAFE_LAUNCH_ARG` with the arg or field name.
 */
export function assertLaunchOptionsAllowed(options: ParsedLaunchOptions | undefined): void {
  if (options === undefined) return;
  assertLaunchArgsAllowed(options.args);
  if (options['chromiumSandbox'] === false) throw unsafeField('chromiumSandbox');
  for (const field of UNSAFE_LAUNCH_OPTION_FIELDS) {
    if (options[field] !== undefined) throw unsafeField(field);
  }
}

function unsafeField(field: string): AppError<'UNSAFE_LAUNCH_ARG'> {
  return new AppError(
    'UNSAFE_LAUNCH_ARG',
    { arg: field },
    {
      publicMessage: `Launch option '${field}' is refused: it bypasses the launch-arg deny-list and would break session isolation.`,
    },
  );
}

/** Chromium flags that configure egress at the command line, bypassing the structured `proxy` option. */
export const PROXY_ARG_PREFIXES: readonly string[] = [
  '--proxy-server',
  '--proxy-pac-url',
  '--host-resolver-rules',
];

/**
 * Whether the caller brought their own egress proxy, by any of the routes Playwright and Chromium
 * accept: `launchOptions.proxy`, `contextOptions.proxy`, a raw `--proxy-*` launch arg, or (D-13) a
 * typed `LaunchSpec.proxy`.
 *
 * This is the trigger for the **downgrade rule**. A host-derived seed asserted over someone else's
 * exit IP is the "US identity over a DE proxy" case — trivially caught, and strictly worse than the
 * honest baseline, because asserting nothing leaves the browser's natural values in place while
 * asserting wrong manufactures a contradiction. So when this returns `true` the identity layer skips
 * the geo assertions entirely (see `identity-resolver.ts`), keeps the non-geo hardening, and warns.
 *
 * The same predicate is what a future proxy layer consumes to decide whether a session's exit is
 * BrowserHive-managed or caller-supplied, so it is not throwaway code.
 */
export function byoProxyPresent(
  launchOptions: LaunchOptions | undefined,
  contextOptions: BrowserContextOptions | undefined,
  proxy: ProxySpec | null = null,
): boolean {
  if (proxy !== null) return true;
  if (launchOptions?.proxy !== undefined) return true;
  if (contextOptions?.proxy !== undefined) return true;
  const args = launchOptions?.args;
  if (!Array.isArray(args)) return false;
  return args.some((arg) => PROXY_ARG_PREFIXES.some((prefix) => arg.startsWith(prefix)));
}

/**
 * Normalise a caller-supplied structured proxy (launch level wins over context level, as it did
 * when Playwright applied both) into the typed {@link ProxySpec}. Raw `--proxy-*` args are
 * detected by {@link byoProxyPresent} but left in `args` (still allowed until a managed layer
 * exists, spec 11 §11).
 */
export function extractByoProxy(
  launchOptions: LaunchOptions | undefined,
  contextOptions: BrowserContextOptions | undefined,
): ProxySpec | null {
  const raw = launchOptions?.proxy ?? contextOptions?.proxy;
  if (raw === undefined) return null;
  return {
    server: raw.server,
    ...(raw.bypass !== undefined && { bypass: raw.bypass }),
    ...(raw.username !== undefined && { username: raw.username }),
    ...(raw.password !== undefined && { password: raw.password }),
    label: proxyLabelFor(raw.server),
    source: 'byo',
  };
}

/** An operator-facing label for a proxy server: scheme + host, never credentials. */
export function proxyLabelFor(server: string): string {
  try {
    const url = new URL(server.includes('://') ? server : `http://${server}`);
    return `byo:${url.host}`;
  } catch {
    return 'byo';
  }
}
