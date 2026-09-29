/** @module app/notifications/links — the `LinkBuilder`s (D-37): links to the public address (`publicUrl`) or, without one, to this computer's dashboard. */

import type { LinkBuilder } from '../../ports/notification-channel.ts';

function join(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * Links to the local dashboard (`http://127.0.0.1:9876/sessions/…`). `local` is true, so
 * renderers label them "Open on this computer" (D-37). `baseUrl` is read per call because the
 * listening port is known only after the listeners open.
 *
 * @returns A link builder over `baseUrl()`.
 */
export function createLocalLinkBuilder(baseUrl: () => string): LinkBuilder {
  return {
    local: true,
    url: (path) => join(baseUrl(), path),
  };
}

/**
 * Links to the address where the operator made the dashboard reachable (`publicUrl`, spec 08
 * §5.8): `publicUrl + path`, a path prefix of `publicUrl` kept. Links never carry a token.
 *
 * @returns A link builder with `local: false`.
 */
export function createPublicLinkBuilder(publicUrl: string): LinkBuilder {
  return {
    local: false,
    url: (path) => join(publicUrl, path),
  };
}

/**
 * The link builder for a configuration: public when `publicUrl` is set, local otherwise.
 *
 * @returns The builder.
 */
export function linkBuilderFor(publicUrl: string | undefined, localUrl: () => string): LinkBuilder {
  return publicUrl === undefined
    ? createLocalLinkBuilder(localUrl)
    : createPublicLinkBuilder(publicUrl);
}
