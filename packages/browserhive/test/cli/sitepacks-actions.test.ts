/** @module test/cli/sitepacks-actions.test — `browserhive sitepacks apply | reject | revert | approve-local | pin | unpin | follow | enable | disable | reload | import` (spec 13 §11.5): confirmations, the pending-version choice, request bodies and exit codes */
import { describe, expect, it } from 'bun:test';
import { MemoryFs } from './helpers.ts';
import {
  fakePackServer,
  packView,
  pendingItem,
  problem,
  run,
  SHA_A,
  SHA_B,
  SHA_L,
  URL_FLAGS,
  writes,
} from './sitepacks-fakes.ts';

const PACK = '/api/v1/site-packs/linkedin.com';
const twoPending = () => packView({ pending: [pendingItem(4), pendingItem(5)] });

describe('sitepacks apply', () => {
  it('refuses without a terminal unless --yes, and sends nothing', async () => {
    const server = fakePackServer();
    const result = await run(server, ['apply', 'linkedin.com', ...URL_FLAGS]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('refusing without confirmation, and stdin is not a terminal');
    expect(writes(server)).toEqual([]);
  });

  it('prints the diff, asks for the pack id and applies the only pending version', async () => {
    const server = fakePackServer();
    const result = await run(server, ['apply', 'linkedin.com', ...URL_FLAGS], {
      answers: ['linkedin.com'],
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('guards[logout].action');
    expect(result.stdout).toContain(
      'This applies v4 of linkedin.com (bundled with BrowserHive 0.3.1) in place of v3.',
    );
    expect(result.prompts).toEqual(['Type the pack id (linkedin.com) to confirm: ']);
    expect(result.stdout).toContain('applied v4 of linkedin.com');
    expect(writes(server)).toEqual([`POST ${PACK}/apply`]);
    expect(server.calls.at(-1)?.body).toEqual({ version: 4 });
  });

  it('a wrong answer aborts', async () => {
    const server = fakePackServer();
    const result = await run(server, ['apply', 'linkedin.com', ...URL_FLAGS], { answers: ['no'] });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('Aborted — nothing was changed.');
    expect(writes(server)).toEqual([]);
  });

  it('with several pending versions needs one; a version that is not pending fails', async () => {
    const many = await run(fakePackServer(twoPending()), [
      'apply',
      'linkedin.com',
      '--yes',
      ...URL_FLAGS,
    ]);
    expect(many.code).toBe(1);
    expect(many.stderr).toContain('several pending versions (v4, v5)');
    const server = fakePackServer(twoPending());
    const chosen = await run(server, ['apply', 'linkedin.com', '5', '--yes', ...URL_FLAGS]);
    expect(chosen.code).toBe(0);
    expect(server.calls.at(-1)?.body).toEqual({ version: 5 });
    const missing = await run(fakePackServer(), [
      'apply',
      'linkedin.com',
      '9',
      '--yes',
      ...URL_FLAGS,
    ]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('v9 of linkedin.com is not pending. Pending: v4.');
  });

  it('a 409 from the server is exit 1 with the code', async () => {
    const server = fakePackServer();
    server.routes = (method, path) =>
      method === 'POST' && path === `${PACK}/apply`
        ? [409, problem(409, 'SITE_PACK_UPDATE_NOT_PENDING', 'Version 4 is not pending.')]
        : undefined;
    const result = await run(server, ['apply', 'linkedin.com', '--yes', ...URL_FLAGS]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('[SITE_PACK_UPDATE_NOT_PENDING] Version 4 is not pending.');
  });
});

describe('sitepacks reject and revert', () => {
  it('reject takes the only pending version without a confirmation', async () => {
    const server = fakePackServer();
    const result = await run(server, ['reject', 'linkedin.com', ...URL_FLAGS]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('rejected v4 of linkedin.com');
    expect(server.calls.at(-1)).toEqual({
      method: 'POST',
      path: `${PACK}/reject`,
      body: { version: 4 },
    });
  });

  it('revert needs a previous version and a confirmation', async () => {
    const none = await run(fakePackServer(), ['revert', 'linkedin.com', '--yes', ...URL_FLAGS]);
    expect(none.code).toBe(1);
    expect(none.stderr).toContain('has no previous approved version to revert to');
    const server = fakePackServer(packView({ previous: { version: 2, source: 'bundled' } }));
    const refused = await run(server, ['revert', 'linkedin.com', ...URL_FLAGS]);
    expect(refused.code).toBe(1);
    const done = await run(server, ['revert', 'linkedin.com', ...URL_FLAGS], {
      answers: ['linkedin.com'],
    });
    expect(done.code).toBe(0);
    expect(done.stdout).toContain('This reverts linkedin.com from v3 to v2 (bundled).');
    expect(writes(server)).toEqual([`POST ${PACK}/revert`]);
  });
});

describe('sitepacks approve-local', () => {
  const changed = () =>
    packView({
      pending: [],
      local: {
        path: '/data/site-packs/local/linkedin.com.json',
        sha256: SHA_L,
        state: 'changed',
        approved_sha256: SHA_A,
        problem: null,
      },
    });

  it('prints the diff and the SHA-256, then approves exactly that hash', async () => {
    const server = fakePackServer(changed());
    const result = await run(server, ['approve-local', 'linkedin.com', ...URL_FLAGS], {
      answers: ['linkedin.com'],
    });
    expect(result.code).toBe(0);
    const out = result.stdout;
    expect(out.indexOf('guards[logout].action')).toBeLessThan(out.indexOf(`SHA-256 ${SHA_L}`));
    expect(out).toContain('Approving the content of /data/site-packs/local/linkedin.com.json');
    expect(server.calls.at(-1)).toEqual({
      method: 'POST',
      path: `${PACK}/approve-local`,
      body: { sha256: SHA_L },
    });
  });

  it('approves the SHA-256 of the diff it printed; a file that changed in between is refused (review S-M3)', async () => {
    const moved = packView({
      pending: [],
      local: {
        path: '/data/site-packs/local/linkedin.com.json',
        sha256: SHA_B,
        state: 'changed',
        approved_sha256: SHA_A,
        problem: null,
      },
    });
    const server = fakePackServer(moved);
    const result = await run(server, ['approve-local', 'linkedin.com', '--yes', ...URL_FLAGS]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('changed while it was read');
    expect(writes(server)).toEqual([]);
  });

  it('refuses without a terminal unless --yes', async () => {
    const server = fakePackServer(changed());
    const refused = await run(server, ['approve-local', 'linkedin.com', ...URL_FLAGS]);
    expect(refused.code).toBe(1);
    expect(writes(server)).toEqual([]);
    const yes = await run(server, ['approve-local', 'linkedin.com', '--yes', ...URL_FLAGS]);
    expect(yes.code).toBe(0);
    expect(writes(server)).toEqual([`POST ${PACK}/approve-local`]);
  });

  it('a stale hash (409) says to review again', async () => {
    const server = fakePackServer(changed());
    server.routes = (method, path) =>
      method === 'POST' && path === `${PACK}/approve-local`
        ? [409, problem(409, 'CONFLICT', 'The local file changed since it was shown.')]
        : undefined;
    const result = await run(server, ['approve-local', 'linkedin.com', '--yes', ...URL_FLAGS]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('[CONFLICT] The local file changed since it was shown.');
    expect(result.stderr).toContain('Run approve-local again to review the new content.');
  });

  it('an approved file needs nothing; no file or an invalid file fails', async () => {
    const approved = packView({
      local: {
        path: '/x.json',
        sha256: SHA_L,
        state: 'approved',
        approved_sha256: SHA_L,
        problem: null,
      },
    });
    const already = await run(fakePackServer(approved), [
      'approve-local',
      'linkedin.com',
      ...URL_FLAGS,
    ]);
    expect(already.code).toBe(0);
    expect(already.stdout).toContain('already approved');
    const none = await run(fakePackServer(), ['approve-local', 'linkedin.com', ...URL_FLAGS]);
    expect(none.code).toBe(1);
    expect(none.stderr).toContain('there is no local file for linkedin.com');
    const invalid = packView({
      local: {
        path: '/x.json',
        sha256: null,
        state: 'not_approved',
        approved_sha256: null,
        problem: 'guards.0.match.url: outside the domains',
      },
    });
    const bad = await run(fakePackServer(invalid), [
      'approve-local',
      'linkedin.com',
      '--yes',
      ...URL_FLAGS,
    ]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('cannot be approved: guards.0.match.url: outside the domains');
  });
});

describe('sitepacks pin, unpin, follow, enable, disable', () => {
  it.each([
    [['pin', 'linkedin.com', '3'], 'PUT', '/pin', { version: 3 }, 'pinned linkedin.com at v3'],
    [['unpin', 'linkedin.com'], 'PUT', '/pin', { version: null }, 'unpinned linkedin.com'],
    [
      ['follow', 'linkedin.com', 'off'],
      'PUT',
      '/follow',
      { follow: false },
      'follow updates of linkedin.com: off',
    ],
    [
      ['follow', 'linkedin.com', 'on'],
      'PUT',
      '/follow',
      { follow: true },
      'follow updates of linkedin.com: on',
    ],
    [
      ['follow', 'linkedin.com', 'auto'],
      'PUT',
      '/follow',
      { follow: null },
      'follow updates of linkedin.com: auto',
    ],
    [['enable', 'linkedin.com'], 'POST', '/enable', {}, 'enabled linkedin.com'],
  ])('%p', async (argv, method, tail, body, text) => {
    const server = fakePackServer();
    const result = await run(server, [...argv, ...URL_FLAGS]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(text);
    expect(server.calls).toEqual([{ method, path: `${PACK}${tail}`, body }]);
  });
});

describe('sitepacks disable (review S-M2)', () => {
  it('refuses without a terminal unless --yes, and sends nothing', async () => {
    const server = fakePackServer();
    const result = await run(server, ['disable', 'linkedin.com', ...URL_FLAGS]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('refusing without confirmation, and stdin is not a terminal');
    expect(writes(server)).toEqual([]);
  });

  it('says what stops applying, asks for the pack id, then disables', async () => {
    const server = fakePackServer();
    const result = await run(server, ['disable', 'linkedin.com', ...URL_FLAGS], {
      answers: ['linkedin.com'],
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      'This turns off LinkedIn (linkedin.com) for every template (1 use it)',
    );
    expect(result.stdout).toContain('sign-out, account and credential guards');
    expect(result.prompts).toEqual(['Type the pack id (linkedin.com) to confirm: ']);
    expect(writes(server)).toEqual([`POST ${PACK}/disable`]);
  });

  it('--yes disables without asking; an already disabled pack needs nothing', async () => {
    const server = fakePackServer();
    const yes = await run(server, ['disable', 'linkedin.com', '--yes', ...URL_FLAGS]);
    expect(yes.code).toBe(0);
    expect(yes.stdout).toContain('disabled linkedin.com');
    const off = fakePackServer(packView({ enabled: false }));
    const again = await run(off, ['disable', 'linkedin.com', ...URL_FLAGS]);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain('already disabled');
    expect(writes(off)).toEqual([]);
  });
});

describe('sitepacks reload', () => {
  it('prints what each source loaded and skipped', async () => {
    const server = fakePackServer();
    server.routes = (method, path) =>
      method === 'POST' && path === '/api/v1/site-packs/reload'
        ? [
            200,
            {
              stats: {
                loaded_at: 1,
                sources: [
                  { source: 'bundled', loaded: 11, skipped: [] },
                  {
                    source: 'local',
                    loaded: 1,
                    skipped: [
                      {
                        pack_id: 'example.com',
                        version: 2,
                        reason: 'invalid',
                        detail: 'domains.0: too short',
                      },
                    ],
                  },
                ],
              },
            },
          ]
        : undefined;
    const result = await run(server, ['reload', ...URL_FLAGS]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('bundled: 11 loaded');
    expect(result.stdout).toContain('local: 1 loaded');
    expect(result.stdout).toContain('example.com v2: invalid domains.0: too short');
  });
});

describe('sitepacks import', () => {
  const fs = () => {
    const memory = new MemoryFs({
      '/work/example.com.json': JSON.stringify({ schema: 1, id: 'example.com' }),
      '/work/broken.json': '{',
      '/work/layout/index.json': '{}',
    });
    return memory;
  };

  it('sends one unsigned pack and says it waits for approval', async () => {
    const server = fakePackServer();
    server.routes = (method, path) =>
      method === 'POST' && path === '/api/v1/site-packs/import'
        ? [
            200,
            {
              imported: [
                { pack_id: 'example.com', version: 1, state: 'not_approved', sha256: SHA_B },
              ],
            },
          ]
        : undefined;
    const result = await run(server, ['import', '/work/example.com.json', ...URL_FLAGS], {
      fs: fs(),
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('imported example.com v1 into the local folder');
    expect(result.stdout).toContain('browserhive sitepacks approve-local example.com');
    // The file's text, byte for byte (review S-L2): no re-serialization.
    expect(server.calls[0]?.body).toEqual({
      text: JSON.stringify({ schema: 1, id: 'example.com' }),
    });
    expect(result.stdout).toContain(`SHA-256 ${SHA_B}`);
    expect(result.stdout).toContain('the stored content differs from /work/example.com.json');
  });

  it('prints no warning when the stored SHA-256 is the file own one', async () => {
    const text = '{ "schema": 1, "id": "example.com" }\n';
    const sha = new Bun.CryptoHasher('sha256').update(text).digest('hex');
    const server = fakePackServer();
    server.routes = (method, path) =>
      method === 'POST' && path === '/api/v1/site-packs/import'
        ? [
            200,
            {
              imported: [
                { pack_id: 'example.com', version: 1, state: 'not_approved', sha256: sha },
              ],
            },
          ]
        : undefined;
    const memory = new MemoryFs({ '/work/example.com.json': text });
    const result = await run(server, ['import', '/work/example.com.json', ...URL_FLAGS], {
      fs: memory,
    });
    expect(result.code).toBe(0);
    expect(server.calls[0]?.body).toEqual({ text });
    expect(result.stdout).not.toContain('differs');
  });

  it('a signed layout folder or file is explained and not sent', async () => {
    const server = fakePackServer();
    for (const path of ['/work/layout', '/work/layout/index.json']) {
      const result = await run(server, ['import', path, ...URL_FLAGS], { fs: fs() });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Signed layouts arrive with a later release');
    }
    expect(server.calls).toEqual([]);
  });

  it('a missing or non-JSON file fails locally; an invalid pack fails with SITE_PACK_INVALID', async () => {
    const server = fakePackServer();
    const missing = await run(server, ['import', '/work/none.json', ...URL_FLAGS], { fs: fs() });
    expect(missing.code).toBe(1);
    const broken = await run(server, ['import', '/work/broken.json', ...URL_FLAGS], { fs: fs() });
    expect(broken.stderr).toContain('is not JSON');
    expect(server.calls).toEqual([]);
    server.routes = () => [
      400,
      problem(
        400,
        'SITE_PACK_INVALID',
        'The site pack from import is not valid: version: required',
      ),
    ];
    const invalid = await run(server, ['import', '/work/example.com.json', ...URL_FLAGS], {
      fs: fs(),
    });
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain('[SITE_PACK_INVALID]');
  });
});
