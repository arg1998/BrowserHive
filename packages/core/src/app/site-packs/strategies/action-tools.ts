/** @module app/site-packs/strategies/action-tools — which tools are "actions" for the before-action strategies (spec 13 §9.4, §9.6 "Before navigation and element actions"): navigations and interactions on a site's pages; one exhaustive table over every tool name. */

import { isToolName, type ToolName } from '@browserhive/contracts/tools';

/**
 * - `navigation`: loads a document in a page (`navigate`, `new_tab` with a `url`, history, reload).
 * - `interaction`: acts on a page's elements (pointer, keyboard, form, scroll, files).
 * - `focus`: moves the session's attention to a page without acting on it (`single-focus` only).
 * - `null`: reads, waits, session and state tools; no before-action strategy applies.
 */
export type ActionKind = 'navigation' | 'interaction' | 'focus';

/** Every tool, classified (a new tool must be placed here: the record is exhaustive). */
export const ACTION_TOOLS: { readonly [K in ToolName]: ActionKind | null } = {
  launch_session: null,
  close_session: null,
  list_sessions: null,
  server_status: null,
  session_info: null,
  navigate: 'navigation',
  go_back: 'navigation',
  go_forward: 'navigation',
  reload: 'navigation',
  wait_for_url: null,
  new_tab: 'navigation',
  close_tab: null,
  switch_tab: 'focus',
  list_tabs: null,
  click: 'interaction',
  type_text: 'interaction',
  fill: 'interaction',
  press_key: 'interaction',
  hover: 'interaction',
  select_option: 'interaction',
  scroll: 'interaction',
  drag_and_drop: 'interaction',
  screenshot: null,
  snapshot: null,
  get_content: null,
  evaluate: null,
  wait_for_selector: null,
  wait_for_load_state: null,
  accept_next_dialog: null,
  dismiss_next_dialog: null,
  get_cookies: null,
  set_cookies: null,
  set_extra_http_headers: null,
  set_viewport: null,
  upload_file: 'interaction',
  download_file: 'interaction',
  save_storage_state: null,
  save_full_profile: null,
  list_saved_auths: null,
  request_attention: null,
  get_attention_result: null,
  vault_list_available: null,
  vault_fill: null,
  list_templates: null,
};

/** Tools whose target is the URL they load rather than the page they act on. */
export const URL_TARGET_TOOLS: ReadonlySet<string> = new Set(['navigate', 'new_tab']);

/** The kind of `tool` with these arguments: `new_tab` without a `url` loads nothing. */
export function actionKindOf(
  tool: string,
  args: Readonly<Record<string, unknown>>,
): ActionKind | null {
  if (!isToolName(tool)) return null;
  if (tool === 'new_tab' && typeof args['url'] !== 'string') return 'focus';
  return ACTION_TOOLS[tool];
}
