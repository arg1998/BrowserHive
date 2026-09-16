/** @module test/integration/core-tools — navigate/fill/type/select/click/get_content/evaluate/screenshot through the dispatcher against real Chromium; actionability mapping. */

import { describe, expect, it } from 'bun:test';
import { textOf } from '../helpers/fake-transport.ts';
import { useMcpStack } from './mcp-fixture.ts';

describe('core tools end-to-end (real Chromium)', () => {
  const { state } = useMcpStack();

  it('navigate + fill + type + select + click + get_content + evaluate + screenshot', async () => {
    const h = state.harness;
    const id = await h.launch({
      slug: 'demo',
      channel: 'chromium',
      incognito: false,
      headless: true,
    });
    expect(id).toMatch(/^demo-[0-9a-z]{8}$/);
    const nav = await h.callJson<{ status: number }>('navigate', {
      session_id: id,
      url: state.fixture.url('/elements'),
    });
    expect(nav.status).toBe(200);
    await h.callJson('fill', { session_id: id, selector: '#text', value: 'alice' });
    await h.callJson('type_text', { session_id: id, selector: '#text', text: '!' });
    await h.callJson('select_option', { session_id: id, selector: '#sel', values: ['b'] });
    await h.callJson('click', { session_id: id, selector: '#btn' });
    const content = await h.callJson<{ html: string }>('get_content', { session_id: id });
    expect(content.html).toContain('clicked');
    const ev = await h.callJson<{ result: string }>('evaluate', {
      session_id: id,
      expression: "() => document.getElementById('text').value",
    });
    expect(ev.result).toBe('alice!');
    const shot = await h.call('screenshot', { session_id: id, full_page: false });
    const image = shot.content.find((c) => c.type === 'image');
    expect(image?.type === 'image' && image.mimeType).toBe('image/png');
    expect(
      Buffer.from(image?.type === 'image' ? image.data : '', 'base64').byteLength,
    ).toBeGreaterThan(100);
    const closed = await h.callJson<{ closed: boolean }>('close_session', { session_id: id });
    expect(closed.closed).toBe(true);
  });

  it('maps a Playwright actionability timeout to ELEMENT_NOT_ACTIONABLE, not INTERNAL_ERROR', async () => {
    const h = state.harness;
    const id = await h.launch({ slug: 'timeout' });
    await h.callJson('navigate', { session_id: id, url: state.fixture.url('/') });
    const result = await h.call('hover', {
      session_id: id,
      selector: '#does-not-exist',
      timeout: 800,
    });
    expect(textOf(result)).toStartWith('[ELEMENT_NOT_ACTIONABLE]');
  });

  it('navigate records HTTP 404 as a soft failure', async () => {
    const h = state.harness;
    const id = await h.launch();
    const nav = await h.callJson<{ status: number }>('navigate', {
      session_id: id,
      url: state.fixture.url('/status?code=404'),
    });
    expect(nav.status).toBe(404);
    expect(h.observations().at(-1)?.errorCode).toBe('HTTP_404');
  });
});
