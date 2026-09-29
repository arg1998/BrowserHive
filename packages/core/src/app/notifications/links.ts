/** @module app/notifications/links — the default `LinkBuilder`: links to this computer's dashboard until `publicUrl` exists (D-37). */

import type { LinkBuilder } from '../../ports/notification-channel.ts';

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
    url(path) {
      const base = baseUrl().replace(/\/+$/, '');
      return `${base}${path.startsWith('/') ? path : `/${path}`}`;
    },
  };
}
