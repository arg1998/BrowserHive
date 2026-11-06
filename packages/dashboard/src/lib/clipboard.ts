/** @module lib/clipboard — copy text to the clipboard, with the `execCommand` fallback for insecure contexts (a LAN address over plain http). React-free, so the offline page uses it too (04 §18.10). */

/**
 * Copy `value` to the clipboard. Uses the async Clipboard API in a secure context; otherwise, or
 * when it rejects, falls back to a temporary off-screen textarea and `execCommand('copy')`.
 *
 * @returns `true` when the text was copied.
 */
export async function copyText(value: string, doc: Document = document): Promise<boolean> {
  const clipboard = doc.defaultView?.navigator.clipboard;
  if (clipboard !== undefined && doc.defaultView?.isSecureContext === true) {
    try {
      await clipboard.writeText(value);
      return true;
    } catch {
      // fall through to the execCommand path
    }
  }
  const area = doc.createElement('textarea');
  area.value = value;
  area.setAttribute('readonly', '');
  area.setAttribute('aria-hidden', 'true');
  area.className = 'sr-only';
  doc.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = doc.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}
