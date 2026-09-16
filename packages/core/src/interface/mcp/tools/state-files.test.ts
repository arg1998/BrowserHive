/** @module interface/mcp/tools/state-files.test — cookies (D-20 shape-only observation), viewport clamp, header refusal, uploads sandbox, downloads. */

import { afterEach, describe, expect, it } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FakeSessionHandle } from '../../../../test/helpers/fake-session-handle.ts';
import {
  createToolHarness,
  type ToolHarness,
  textOf,
} from '../../../../test/helpers/fake-transport.ts';
import { executeTool } from '../../../../test/helpers/tool-run.ts';
import { clampToAssertedDisplay, splitIdentityHeaders } from './state/headers.ts';

let h: ToolHarness;
afterEach(async () => h.close());

function handle(): FakeSessionHandle {
  const found = h.fakeDriver?.handles[0];
  if (found === undefined) throw new Error('no handle');
  return found;
}

describe('state tools', () => {
  it('set_cookies then get_cookies round-trips; the observation never records cookie values', async () => {
    h = await createToolHarness();
    const id = await h.launch();
    const added = await executeTool(h, 'set_cookies', {
      session_id: id,
      cookies: [
        {
          name: 'sid',
          value: 'abc123secret',
          url: 'http://127.0.0.1',
          domain: '127.0.0.1',
          path: '/',
          expires: -1,
          httpOnly: false,
          secure: false,
          sameSite: 'Lax',
        },
      ],
    });
    expect(added.value).toEqual({ added: 1 });
    const got = await executeTool(h, 'get_cookies', { session_id: id, urls: ['http://127.0.0.1'] });
    expect((got.value as { cookies: { value: string }[] }).cookies[0]?.value).toBe('abc123secret');
    for (const obs of h.observations()) {
      expect(JSON.stringify(obs)).not.toContain('abc123secret');
    }
  });

  it('set_cookies maps Playwright validation to INVALID_ARGUMENTS', async () => {
    h = await createToolHarness();
    const id = await h.launch();
    const result = await h.call('set_cookies', {
      session_id: id,
      cookies: [{ name: 'a', value: 'b' }],
    });
    expect(textOf(result)).toBe(
      '[INVALID_ARGUMENTS] cookies: Cookie should have a url or a domain/path pair',
    );
  });

  it('set_viewport omits `clamped` unless it clamped', async () => {
    h = await createToolHarness();
    const id = await h.launch();
    const { value } = await executeTool(h, 'set_viewport', {
      session_id: id,
      width: 800,
      height: 640,
    });
    expect(value).toEqual({ session_id: id, width: 800, height: 640 });
    const display = {
      screen: { width: 1440, height: 900 },
      viewport: { width: 1280, height: 760 },
      deviceScaleFactor: 2,
    };
    const identity = {
      userAgent: '',
      brands: [],
      platform: '',
      deviceMemory: 8,
      chromeMajor: '1',
      geo: null,
      display,
    };
    expect(clampToAssertedDisplay(identity, 4000, 3000)).toEqual({
      width: 1440,
      height: 760,
      clamped: true,
    });
    expect(clampToAssertedDisplay(null, 4000, 3000).clamped).toBe(false);
  });

  it('set_extra_http_headers refuses identity-owned headers on stealth sessions only', async () => {
    h = await createToolHarness();
    const plain = await h.launch();
    const applied = await executeTool(h, 'set_extra_http_headers', {
      session_id: plain,
      headers: { 'x-test': '1', 'User-Agent': 'x' },
    });
    expect(applied.value).toEqual({ session_id: plain, applied: 2, rejected: [] });
    const stealth = await h.launch({ slug: 'st', stealth: true });
    const refused = await executeTool(h, 'set_extra_http_headers', {
      session_id: stealth,
      headers: { 'x-test': '1', 'User-Agent': 'x', 'Sec-CH-UA-Platform': 'y' },
    });
    expect(refused.value).toEqual({
      session_id: stealth,
      applied: 1,
      rejected: ['User-Agent', 'Sec-CH-UA-Platform'],
    });
    expect(splitIdentityHeaders({ 'accept-language': 'de' }, true).rejected).toEqual([
      'accept-language',
    ]);
  });
});

describe('file tools', () => {
  it('upload_file accepts paths under uploads/ and refuses others', async () => {
    h = await createToolHarness();
    const id = await h.launch();
    const file = join(h.dataDir, 'uploads', 'a.txt');
    await writeFile(file, 'x');
    const { value } = await executeTool(h, 'upload_file', {
      session_id: id,
      selector: '#file',
      paths: [file],
    });
    expect(value).toEqual({ session_id: id, selector: '#file', ok: true });
    expect(h.script.inputFiles).toHaveLength(1);
    const refused = await h.call('upload_file', {
      session_id: id,
      selector: '#file',
      paths: ['/etc/passwd'],
    });
    expect(textOf(refused)).toStartWith('[PATH_NOT_ALLOWED]');
    const empty = await h.call('upload_file', { session_id: id, selector: '#file', paths: [] });
    expect(textOf(empty)).toBe('[INVALID_ARGUMENTS] paths: paths must include at least one file');
  });

  it('download_file saves into the managed downloads dir (save_as is a basename)', async () => {
    h = await createToolHarness();
    const id = await h.launch();
    const { value } = await executeTool(h, 'download_file', {
      session_id: id,
      trigger_selector: '#download',
      save_as: '../../escape.txt',
    });
    expect(value).toEqual({
      session_id: id,
      saved_to: join(h.dataDir, 'sessions', id, 'downloads', 'escape.txt'),
      suggested_name: 'fixture.txt',
      size: h.script.downloadBody.length,
    });
    handle().firstPage.failWith('click', new Error('page.click: element detached'));
    expect(
      textOf(await h.call('download_file', { session_id: id, trigger_selector: '#x' })),
    ).toStartWith('[DOWNLOAD_FAILED]');
  });
});
