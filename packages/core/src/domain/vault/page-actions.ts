/** @module domain/vault/page-actions — page-level helpers of the fill: form-action defence, best-effort clear, safe url read. */

import { checkOrigin } from './origin.ts';
import type { VaultFillRequest, VaultPage } from './types.ts';

/**
 * Form-action mutation defence: the `action` of the form owning the password field, when a
 * concrete cross-origin http(s) URL, means the form was rewired to exfiltrate. No action,
 * same-page/relative/`javascript:` actions, or a page without `$eval` pass through.
 */
export async function formActionAllowed(
  page: VaultPage,
  passwordSelector: string,
  allowedOrigins: readonly string[],
): Promise<boolean> {
  if (typeof page.$eval !== 'function') return true;
  let action: string | null;
  try {
    action = await page.$eval(passwordSelector, (el) => {
      // Runs in the browser: no closures, no DOM types; walk the shape defensively.
      if (typeof el !== 'object' || el === null || !('form' in el)) return null;
      const form = el.form;
      if (typeof form !== 'object' || form === null || !('action' in form)) return null;
      return typeof form.action === 'string' ? form.action : null;
    });
  } catch {
    return true;
  }
  if (action === null || action.length === 0) return true;
  const check = checkOrigin(action, allowedOrigins);
  if (check.outcome === 'pass') return true;
  return check.reason === 'bad_scheme' || check.reason === 'no_host';
}

/** Best-effort clear of the filled inputs; the page may have navigated. */
export async function clearInputs(page: VaultPage, request: VaultFillRequest): Promise<void> {
  await page.fill(request.passwordSelector, '', { timeout: 1000 }).catch(() => undefined);
  await page.fill(request.usernameSelector, '', { timeout: 1000 }).catch(() => undefined);
}

/** `page.url()` or `''` when the page is gone. */
export function safeUrl(page: VaultPage): string {
  try {
    return page.url();
  } catch {
    return '';
  }
}
