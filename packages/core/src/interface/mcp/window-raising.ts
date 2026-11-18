/** @module interface/mcp/window-raising — the tools whose calls can restore a minimized headed window (D-77, review #89 F4): they press a pointer in the page (Chrome on Linux then activates the window), or size or open a window. Only these are wrapped in `SessionView.aroundAction`; a read-only tool or a long wait (`request_attention`, `wait_for_*`) never minimizes a window the operator is using. */

import type { ToolName } from '@browserhive/contracts/tools';

/**
 * Tools that can restore a minimized window: `click` and `drag_and_drop` press a pointer;
 * `type_text` clicks its field first when humanized; `download_file` and `vault_fill` click a
 * trigger or the submit button; `set_viewport` sizes the window (Playwright, emulated viewport);
 * `new_tab` opens one. `fill`, `select_option`, `press_key`, `hover`, `scroll` and `upload_file`
 * press no pointer (measured, review #89 §1).
 */
export const WINDOW_RAISING_TOOLS: ReadonlySet<string> = new Set([
  'click',
  'drag_and_drop',
  'type_text',
  'download_file',
  'vault_fill',
  'set_viewport',
  'new_tab',
] as const satisfies readonly ToolName[]);
