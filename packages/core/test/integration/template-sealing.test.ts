/// <reference lib="dom" />
/** @module test/integration/template-sealing.test — the sealing invariant of spec 13 §14 over the real tool stack and a real template host (§5.4, §5.5): a sentinel cookie (also embedded in the page), a localStorage and an IndexedDB sentinel never reach an agent-facing result or a stored tool-call text of a sealed session; every sealed tool refuses typed; unsealing applies per flag and per principal. */

import { afterEach, describe, expect, it } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { agentPrincipal } from '../../src/domain/auth/principal.ts';
import { textOf } from '../helpers/fake-transport.ts';
import {
  SENTINEL_COOKIE_VALUE,
  SENTINEL_QUOTED_VALUE,
  SENTINEL_STORAGE_VALUE,
} from '../helpers/https-sites-signin.ts';
import { SELF_ORIGIN, type TemplateMcp, templateMcp } from './template-mcp-fixture.ts';

const DRIVERS = ['playwright', 'patchright'] as const;
/** What must never appear, raw or escaped: the quoted value is checked by its unquoted core. */
const SENTINELS = [
  SENTINEL_COOKIE_VALUE,
  SENTINEL_STORAGE_VALUE,
  SENTINEL_QUOTED_VALUE.replace(/"/g, ''),
];

let world: TemplateMcp | null = null;
afterEach(async () => {
  await world?.stop();
  world = null;
});

/** The `[CODE]` of an error result, or `ok`. */
function codeOf(result: CallToolResult): string {
  if (result.isError !== true) return 'ok';
  return /^\[([A-Z_]+)\]/.exec(textOf(result))?.[1] ?? 'unknown';
}

/** The structured result, typed by the caller. */
function structured<T>(result: CallToolResult): T {
  return result.structuredContent as T;
}

async function launch(w: TemplateMcp, client?: Client): Promise<string> {
  const launched = await w.harness.callJson<{ session_id: string }>(
    'launch_session',
    { slug: 'sealed', template: w.template.name },
    client,
  );
  return launched.session_id;
}

/** Every agent-facing text this test saw, plus the observed (stored) result texts. */
function leaks(w: TemplateMcp, results: readonly CallToolResult[]): string[] {
  const texts = [
    // The raw text blocks as the agent reads them, and the structured content.
    ...results.flatMap((r) => r.content.map((c) => (c.type === 'text' ? c.text : ''))),
    ...results.map((r) => JSON.stringify(r.structuredContent ?? {})),
    ...w.harness.observations().map((o) => `${o.resultText ?? ''} ${o.errorMessage ?? ''}`),
  ];
  return SENTINELS.filter((s) => texts.some((t) => t.includes(s)));
}

for (const driver of DRIVERS) {
  describe(`sealed template sessions (${driver})`, () => {
    it('never return a sentinel, across every reading tool and refused attempts', async () => {
      world = await templateMcp(driver);
      const w = world;
      const id = await launch(w);
      const url = w.sites.url('site-a.test', '/sealed');
      const results: CallToolResult[] = [];
      const call = async (name: string, args: Record<string, unknown> = {}) => {
        const result = await w.harness.call(name, { session_id: id, ...args });
        results.push(result);
        return result;
      };
      expect(codeOf(await call('navigate', { url }))).toBe('ok');
      await call('wait_for_selector', { selector: '#token' });
      // The page shows its stored value once IndexedDB has it (the storage sentinel in the DOM).
      await call('wait_for_selector', { selector: 'text=/stored sentinel/' });
      // The sentinel cookie value is in the page's HTML: get_content and snapshot show `[sealed]`.
      const content = textOf(await call('get_content'));
      expect(content).toContain('[sealed]');
      expect(content).not.toContain(SENTINEL_COOKIE_VALUE);
      expect(textOf(await call('snapshot'))).toContain('[sealed]');
      // A wait whose failure message would quote the page.
      await call('wait_for_selector', { selector: `text=${SENTINEL_COOKIE_VALUE}`, timeout: 500 });
      // Cookies: only the template's sites, values empty, `sealed: true`.
      await w.harness.call('new_tab', {
        session_id: id,
        url: w.sites.url('idp.test', '/set-cookie'),
      });
      const listed = structured<{ cookies: { domain: string; value: string }[]; sealed?: boolean }>(
        await call('get_cookies'),
      );
      expect(listed?.sealed).toBe(true);
      expect(listed?.cookies.length).toBeGreaterThan(0);
      expect(listed?.cookies.every((c) => c.value === '' && c.domain.endsWith('site-a.test'))).toBe(
        true,
      );
      // A URL carrying a cookie value (`?sid=…`) is sealed wherever an agent reads it (review M-2).
      expect(
        codeOf(
          await call('navigate', {
            url: w.sites.url(
              'site-a.test',
              `/landing?sid=${encodeURIComponent(SENTINEL_COOKIE_VALUE)}`,
            ),
          }),
        ),
      ).toBe('ok');
      for (const name of ['list_sessions', 'session_info', 'list_tabs']) {
        const args = name === 'list_sessions' ? {} : { session_id: id };
        const result = await w.harness.call(name, args);
        results.push(result);
        expect([name, textOf(result).includes('[sealed]')]).toEqual([name, true]);
      }
      // Every sealed tool refuses, typed.
      expect(codeOf(await call('evaluate', { expression: 'document.cookie' }))).toBe(
        'EVALUATE_DISABLED',
      );
      expect(codeOf(await call('set_cookies', { cookies: [{ name: 'x', value: 'y', url }] }))).toBe(
        'SESSION_SEALED',
      );
      expect(codeOf(await call('save_storage_state', { name: 'copy' }))).toBe('SESSION_SEALED');
      expect(codeOf(await call('save_full_profile', { name: 'copy' }))).toBe(
        'INVALID_PERSISTENCE_CONFIG',
      );
      // Non-web schemes and BrowserHive itself, before the browser is touched.
      expect(codeOf(await call('navigate', { url: 'data:text/html,<p>x</p>' }))).toBe(
        'URL_SCHEME_NOT_ALLOWED',
      );
      expect(codeOf(await call('navigate', { url: 'javascript:alert(document.cookie)' }))).toBe(
        'URL_SCHEME_NOT_ALLOWED',
      );
      expect(codeOf(await call('new_tab', { url: 'data:text/html,x' }))).toBe(
        'URL_SCHEME_NOT_ALLOWED',
      );
      const self = await call('navigate', { url: `${SELF_ORIGIN}/api/v1/system` });
      expect(codeOf(self)).toBe('URL_BLOCKED');
      expect(textOf(self)).toContain('#browserhive');
      // Clipboard chords never reach the page.
      expect(codeOf(await call('press_key', { key: 'Control+V' }))).toBe('INVALID_ARGUMENTS');
      expect(codeOf(await call('press_key', { key: 'Tab' }))).toBe('ok');
      // A middle click would paste the operator's primary selection (Linux): refused (review M-3).
      expect(codeOf(await call('click', { selector: '#token', button: 'middle' }))).toBe(
        'INVALID_ARGUMENTS',
      );
      expect(
        codeOf(await call('click', { selector: 'body', button: 'right', timeout: 5_000 })),
      ).toBe('ok');
      // The vault: nothing offered, every fill refused and audited as a template session.
      const available = structured<{ entries: unknown[]; note?: string }>(
        await call('vault_list_available'),
      );
      expect(available.entries).toEqual([]);
      expect(available.note).toContain('not available in template sessions');
      const fill = structured<{ status: string; reason?: string }>(
        await call('vault_fill', {
          entry_name: 'site-a',
          username_selector: '#u',
          password_selector: '#p',
        }),
      );
      expect(fill).toMatchObject({ status: 'blocked', reason: 'not_authorized' });
      const audited = w.harness.bus.published.filter((e) => e.name === 'vault.access');
      expect(JSON.stringify(audited.at(-1)?.payload)).toContain('template_session');
      expect(leaks(w, results)).toEqual([]);
    });

    it('unseals each flag for the listed principals only', async () => {
      world = await templateMcp(driver, {
        unseal: {
          cookieValues: true,
          evaluate: true,
          cookieWrites: true,
          stateExport: true,
          principals: ['alice'],
        },
      });
      const w = world;
      const alice = await w.harness.connect(agentPrincipal('alice', {}));
      const bob = await w.harness.connect(agentPrincipal('bob', {}));
      const a = await launch(w, alice);
      const b = await launch(w, bob);
      const url = w.sites.url('site-a.test', '/sealed');
      await w.harness.call('navigate', { session_id: a, url }, alice);
      await w.harness.call('navigate', { session_id: b, url }, bob);
      // Alice: values, evaluate, writes and export.
      const aliceCookies = await w.harness.callJson<{
        cookies: { name: string; value: string }[];
        sealed?: boolean;
      }>('get_cookies', { session_id: a }, alice);
      expect(aliceCookies.sealed).toBeUndefined();
      expect(aliceCookies.cookies.find((c) => c.name === 'bh_sentinel')?.value).toBe(
        SENTINEL_COOKIE_VALUE,
      );
      expect(
        codeOf(await w.harness.call('evaluate', { session_id: a, expression: '1 + 1' }, alice)),
      ).toBe('ok');
      expect(
        codeOf(
          await w.harness.call(
            'set_cookies',
            { session_id: a, cookies: [{ name: 'from_alice', value: 'v', url }] },
            alice,
          ),
        ),
      ).toBe('ok');
      expect(
        codeOf(
          await w.harness.call('save_storage_state', { session_id: a, name: 'export' }, alice),
        ),
      ).toBe('ok');
      // The export is alice's own, and says where it came from.
      const dir = join(w.harness.dataDir, 'auth-states', 'p');
      const [owner] = await readdir(dir);
      const manifest = JSON.parse(
        await readFile(join(dir, owner ?? '', 'export.meta.json'), 'utf8'),
      ) as { source_template_id?: string; owner: string };
      expect(manifest).toMatchObject({ owner: 'alice', source_template_id: w.template.templateId });
      // Bob: still sealed, and alice's write is in the one jar (a template is one person).
      const bobCookies = await w.harness.callJson<{
        cookies: { name: string; value: string }[];
        sealed?: boolean;
      }>('get_cookies', { session_id: b }, bob);
      expect(bobCookies.sealed).toBe(true);
      expect(bobCookies.cookies.find((c) => c.name === 'from_alice')?.value).toBe('');
      expect(
        codeOf(await w.harness.call('evaluate', { session_id: b, expression: '1' }, bob)),
      ).toBe('EVALUATE_DISABLED');
      expect(textOf(await w.harness.call('get_content', { session_id: b }, bob))).not.toContain(
        SENTINEL_COOKIE_VALUE,
      );
    });
  });
}
