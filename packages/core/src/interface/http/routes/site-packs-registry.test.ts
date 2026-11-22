/** @module interface/http/routes/site-packs-registry.test — the registry client over REST (spec 13 §11.1, T4b): Check now lists v2 as available; Download & review returns the classified diff; Apply then makes it approved with its registry provenance; a signed import `{files}` (base64) is verified and queued; a bad encoding or a path outside the layout is 400; export returns the held layout; Check now is rate limited. */

import { describe, expect, it } from 'bun:test';
import {
  ProblemDetails,
  SitePackCheckResponse,
  SitePackDownloadResponse,
  SitePackExportResponse,
  SitePackImportResponse,
  SitePackViewResponse,
} from '@browserhive/contracts/http';
import { createHttpKit } from '../../../../test/helpers/http-kit.ts';
import { packSha, sitePack } from '../../../../test/helpers/site-pack-kit.ts';

const api = (path: string) => `/api/v1${path}`;

async function approvedKit() {
  const kit = await createHttpKit();
  const cookie = await kit.login();
  await kit.sitePacks.registry.approveSite(
    'pack-a.test',
    packSha(sitePack('pack-a.test', 1)),
    'admin',
  );
  return { kit, cookie };
}

describe('the registry client over REST', () => {
  it('Check now, Download & review, Apply', async () => {
    const { kit, cookie } = await approvedKit();
    const check = await kit.request('POST', api('/site-packs/check'), { cookie });
    expect(check.status).toBe(200);
    const checked = SitePackCheckResponse.parse(await check.json());
    expect(checked).toMatchObject({ outcome: 'updated', available: 1 });
    expect(checked.status).toMatchObject({
      index_version: 10,
      trusts_registry: true,
      check_off: null,
    });

    const download = await kit.request('POST', api('/site-packs/pack-a.test/download'), {
      cookie,
      body: { version: 2 },
    });
    expect(download.status).toBe(200);
    const downloaded = SitePackDownloadResponse.parse(await download.json());
    expect(downloaded.view.pending[0]?.state).toBe('downloaded');
    expect(downloaded.diff.to.version).toBe(2);

    const apply = await kit.request('POST', api('/site-packs/pack-a.test/apply'), {
      cookie,
      body: { version: 2 },
    });
    expect(apply.status).toBe(200);
    const { view } = SitePackViewResponse.parse(await apply.json());
    expect(view.approved).toMatchObject({ version: 2, source: 'remote' });
    expect(view.approved?.provenance).toMatchObject({ kind: 'remote', index_version: 10 });
  });

  it('a version the index does not list is 409 SITE_PACK_NOT_LISTED', async () => {
    const { kit, cookie } = await approvedKit();
    await kit.request('POST', api('/site-packs/check'), { cookie });
    const response = await kit.request('POST', api('/site-packs/pack-a.test/download'), {
      cookie,
      body: { version: 9 },
    });
    expect(response.status).toBe(409);
    expect(ProblemDetails.parse(await response.json()).code).toBe('SITE_PACK_NOT_LISTED');
  });

  it('imports a signed layout ({files}, base64) and exports the held one', async () => {
    const { kit, cookie } = await approvedKit();
    const files: Record<string, string> = {};
    for (const [path, bytes] of kit.testRegistry.files)
      files[path] = Buffer.from(bytes).toString('base64');
    const response = await kit.request('POST', api('/site-packs/import'), {
      cookie,
      body: { files, name: 'usb-export' },
    });
    expect(response.status).toBe(200);
    const imported = SitePackImportResponse.parse(await response.json());
    expect(imported.layout).toMatchObject({ outcome: 'updated', index_version: 10 });
    expect(imported.imported).toEqual([
      expect.objectContaining({ pack_id: 'pack-a.test', version: 2, state: 'downloaded' }),
    ]);
    const exported = await kit.request('GET', api('/site-packs/export'), { cookie });
    expect(exported.status).toBe(200);
    const layout = SitePackExportResponse.parse(await exported.json());
    expect(Object.keys(layout.files).sort()).toEqual(Object.keys(files).sort());
    for (const [path, b64] of Object.entries(files)) expect(layout.files[path]).toBe(b64);
  });

  it('refuses a file outside the layout and a bad encoding', async () => {
    const { kit, cookie } = await approvedKit();
    for (const files of [{ '../etc/passwd': 'AAAA' }, { 'keys.json': 'not base64!' }]) {
      const response = await kit.request('POST', api('/site-packs/import'), {
        cookie,
        body: { files },
      });
      expect(response.status).toBe(400);
      expect(ProblemDetails.parse(await response.json()).code).toBe('SITE_PACK_INVALID');
    }
  });

  it('rate limits Check now to 6 a minute', async () => {
    const { kit, cookie } = await approvedKit();
    const statuses: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      statuses.push((await kit.request('POST', api('/site-packs/check'), { cookie })).status);
    }
    expect(statuses.slice(0, 6).every((s) => s === 200)).toBe(true);
    expect(statuses[6]).toBe(429);
  });
});
