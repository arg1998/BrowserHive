/** @module test/cli/shorthand — the `doctor` `bh` lookup on Linux, macOS and Windows layouts (npm, pnpm and Bun installs, a user's own `bh`) with an in-memory filesystem */
import { describe, expect, it } from 'bun:test';
import { posix, win32 } from 'node:path';
import { findShorthand, type ShorthandFs } from '../../src/cli/production/shorthand.ts';

interface Entry {
  readonly bytes?: Uint8Array;
  readonly mode?: number;
  /** A symlink target (absolute). */
  readonly link?: string;
  /** Reading it throws (EACCES). */
  readonly unreadable?: boolean;
}

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const utf16 = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'utf16le'));

/** A filesystem of absolute paths; Windows paths compare case-insensitively, like NTFS. */
function memoryFs(platform: NodeJS.Platform, files: Record<string, Entry>): ShorthandFs {
  const key = (path: string): string =>
    platform === 'win32' ? win32.normalize(path).toLowerCase() : posix.normalize(path);
  const table = new Map(Object.entries(files).map(([path, entry]) => [key(path), entry]));
  const resolve = (path: string, depth = 0): { path: string; entry: Entry } | null => {
    const entry = table.get(key(path));
    if (entry === undefined || depth > 8) return null;
    return entry.link === undefined ? { path, entry } : resolve(entry.link, depth + 1);
  };
  return {
    stat: (path) => {
      const found = resolve(path);
      return found === null ? null : { isFile: true, mode: found.entry.mode ?? 0o755 };
    },
    realpath: (path) => {
      const found = resolve(path);
      if (found === null) throw new Error(`ENOENT: ${path}`);
      return found.path;
    },
    read: (path, maxBytes) => {
      const found = resolve(path);
      if (found === null) throw new Error(`ENOENT: ${path}`);
      if (found.entry.unreadable === true) throw new Error(`EACCES: permission denied, ${path}`);
      return (found.entry.bytes ?? new Uint8Array()).subarray(0, maxBytes);
    },
  };
}

/** The bundled `dist/bin.js`: large, starts with the Bun shebang. */
const BIN_JS: Entry = { bytes: utf8(`#!/usr/bin/env bun\n${'x'.repeat(70_000)}`), mode: 0o755 };
const USER_SCRIPT: Entry = { bytes: utf8('#!/bin/sh\nexec bazel-helper "$@"\n'), mode: 0o755 };

// npm's cmd-shim output for a `#!/usr/bin/env bun` bin (abridged to the line that matters).
const NPM_CMD = utf8(
  '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n' +
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\browserhive\\dist\\bin.js" %*\r\n',
);
const NPM_PS1 = utf8(
  '#!/usr/bin/env pwsh\n$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent\n' +
    '& "bun$exe"  "$basedir/node_modules/browserhive/dist/bin.js" $args\nexit $LASTEXITCODE\n',
);
const NPM_SH = utf8(
  '#!/bin/sh\nbasedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")\n' +
    'exec bun  "$basedir/node_modules/browserhive/dist/bin.js" "$@"\n',
);
// Bun's Windows launcher is one generic .exe; the target lives in the UTF-16LE `.bunx` beside it.
const BUN_EXE = new Uint8Array(200_000).fill(0x4d);
const BUN_BUNX = utf16('..\\install\\global\\node_modules\\browserhive\\dist\\bin.js"bun\0\0');

describe('findShorthand on Linux and macOS', () => {
  const NPM_LINUX = {
    '/usr/lib/node_modules/browserhive/dist/bin.js': BIN_JS,
    '/usr/local/bin/bh': { link: '/usr/lib/node_modules/browserhive/dist/bin.js' },
    '/usr/local/bin/browserhive': { link: '/usr/lib/node_modules/browserhive/dist/bin.js' },
  };

  it('an npm global install (symlink into node_modules) is BrowserHive', () => {
    const fs = memoryFs('linux', NPM_LINUX);
    expect(
      findShorthand({ platform: 'linux', env: { PATH: '/usr/bin:/usr/local/bin' }, fs }),
    ).toEqual({ kind: 'browserhive', path: '/usr/local/bin/bh' });
  });

  it('a Bun global install on macOS (~/.bun/bin symlink) is BrowserHive', () => {
    const fs = memoryFs('darwin', {
      '/Users/me/.bun/install/global/node_modules/browserhive/dist/bin.js': BIN_JS,
      '/Users/me/.bun/bin/bh': {
        link: '/Users/me/.bun/install/global/node_modules/browserhive/dist/bin.js',
      },
    });
    expect(
      findShorthand({
        platform: 'darwin',
        env: { PATH: '/opt/homebrew/bin:/Users/me/.bun/bin:/usr/bin' },
        fs,
      }),
    ).toEqual({ kind: 'browserhive', path: '/Users/me/.bun/bin/bh' });
  });

  it('a pnpm shell shim naming browserhive/dist/bin.js is BrowserHive', () => {
    const fs = memoryFs('linux', {
      '/home/me/.local/share/pnpm/bh': {
        bytes: utf8(
          '#!/bin/sh\nexec bun "$basedir/global/5/.pnpm/browserhive@0.2.1/node_modules/browserhive/dist/bin.js" "$@"\n',
        ),
        mode: 0o755,
      },
    });
    expect(
      findShorthand({ platform: 'linux', env: { PATH: '/home/me/.local/share/pnpm' }, fs }),
    ).toEqual({ kind: 'browserhive', path: '/home/me/.local/share/pnpm/bh' });
  });

  it("a user's own bh earlier on PATH is reported as other", () => {
    const fs = memoryFs('linux', { ...NPM_LINUX, '/home/me/bin/bh': USER_SCRIPT });
    expect(
      findShorthand({ platform: 'linux', env: { PATH: '/home/me/bin:/usr/local/bin' }, fs }),
    ).toEqual({ kind: 'other', path: '/home/me/bin/bh' });
  });

  it('a symlink to some other program is other', () => {
    const fs = memoryFs('linux', {
      '/opt/tools/bh-1.0/bh': USER_SCRIPT,
      '/usr/local/bin/bh': { link: '/opt/tools/bh-1.0/bh' },
    });
    expect(findShorthand({ platform: 'linux', env: { PATH: '/usr/local/bin' }, fs })).toEqual({
      kind: 'other',
      path: '/usr/local/bin/bh',
    });
  });

  it('a large binary is other, even beside our browserhive', () => {
    const fs = memoryFs('linux', {
      ...NPM_LINUX,
      '/usr/local/bin/bh': { bytes: new Uint8Array(100_000), mode: 0o755 },
    });
    expect(findShorthand({ platform: 'linux', env: { PATH: '/usr/local/bin' }, fs }).kind).toBe(
      'other',
    );
  });

  it('a non-executable bh is skipped, like the shell does', () => {
    const fs = memoryFs('linux', {
      ...NPM_LINUX,
      '/home/me/bin/bh': { ...USER_SCRIPT, mode: 0o644 },
    });
    expect(
      findShorthand({ platform: 'linux', env: { PATH: '/home/me/bin:/usr/local/bin' }, fs }),
    ).toEqual({ kind: 'browserhive', path: '/usr/local/bin/bh' });
  });

  it('no bh on PATH (or no PATH at all) is absent', () => {
    const fs = memoryFs('linux', { '/usr/local/bin/browserhive': BIN_JS });
    expect(findShorthand({ platform: 'linux', env: { PATH: '/usr/local/bin' }, fs })).toEqual({
      kind: 'absent',
    });
    expect(findShorthand({ platform: 'linux', env: {}, fs })).toEqual({ kind: 'absent' });
  });

  it('an unreadable bh is unknown, with the reason', () => {
    const fs = memoryFs('linux', { '/usr/local/bin/bh': { ...USER_SCRIPT, unreadable: true } });
    expect(findShorthand({ platform: 'linux', env: { PATH: '/usr/local/bin' }, fs })).toEqual({
      kind: 'unknown',
      path: '/usr/local/bin/bh',
      reason: 'EACCES: permission denied, /usr/local/bin/bh',
    });
  });
});

describe('findShorthand on Windows', () => {
  const NPM_PREFIX = 'C:\\Users\\me\\AppData\\Roaming\\npm';
  const NPM_WINDOWS: Record<string, Entry> = {
    [`${NPM_PREFIX}\\bh`]: { bytes: NPM_SH },
    [`${NPM_PREFIX}\\bh.cmd`]: { bytes: NPM_CMD },
    [`${NPM_PREFIX}\\bh.ps1`]: { bytes: NPM_PS1 },
    [`${NPM_PREFIX}\\browserhive`]: { bytes: NPM_SH },
    [`${NPM_PREFIX}\\browserhive.cmd`]: { bytes: NPM_CMD },
    [`${NPM_PREFIX}\\browserhive.ps1`]: { bytes: NPM_PS1 },
    [`${NPM_PREFIX}\\node_modules\\browserhive\\dist\\bin.js`]: BIN_JS,
  };

  it("npm's .cmd and .ps1 shims are BrowserHive (Path spelled the Windows way)", () => {
    const fs = memoryFs('win32', NPM_WINDOWS);
    expect(
      findShorthand({
        platform: 'win32',
        env: { Path: `C:\\Windows\\system32;${NPM_PREFIX}`, PATHEXT: '.COM;.EXE;.BAT;.CMD' },
        fs,
      }),
    ).toEqual({ kind: 'browserhive', path: `${NPM_PREFIX}\\bh.ps1` });
  });

  it("Bun's .exe launcher is BrowserHive through the .bunx file beside it", () => {
    const fs = memoryFs('win32', {
      'C:\\Users\\me\\.bun\\bin\\bh.exe': { bytes: BUN_EXE },
      'C:\\Users\\me\\.bun\\bin\\bh.bunx': { bytes: BUN_BUNX },
    });
    expect(
      findShorthand({ platform: 'win32', env: { PATH: '"C:\\Users\\me\\.bun\\bin"' }, fs }),
    ).toEqual({ kind: 'browserhive', path: 'C:\\Users\\me\\.bun\\bin\\bh.exe' });
  });

  it('a shim in an unknown format still counts when it matches the browserhive one beside it', () => {
    const shim = utf8('launch target-7f\r\n');
    const fs = memoryFs('win32', {
      'D:\\pm\\bin\\bh.cmd': { bytes: shim },
      'D:\\pm\\bin\\browserhive.cmd': { bytes: shim },
    });
    expect(findShorthand({ platform: 'win32', env: { PATH: 'D:\\pm\\bin' }, fs }).kind).toBe(
      'browserhive',
    );
  });

  it("a user's bh.ps1 earlier on PATH is other (PowerShell runs .ps1 too)", () => {
    const fs = memoryFs('win32', {
      ...NPM_WINDOWS,
      'C:\\tools\\bh.ps1': { bytes: utf8('Write-Output "bazel helper"\n') },
    });
    expect(
      findShorthand({ platform: 'win32', env: { PATH: `C:\\tools;${NPM_PREFIX}` }, fs }),
    ).toEqual({ kind: 'other', path: 'C:\\tools\\bh.ps1' });
  });

  it('a stray bh.bat beside our shims is other: cmd.exe could pick it', () => {
    const fs = memoryFs('win32', {
      ...NPM_WINDOWS,
      [`${NPM_PREFIX}\\bh.bat`]: { bytes: utf8('@echo bazel helper\r\n') },
    });
    expect(findShorthand({ platform: 'win32', env: { PATH: NPM_PREFIX }, fs })).toEqual({
      kind: 'other',
      path: `${NPM_PREFIX}\\bh.bat`,
    });
  });

  it('PATHEXT decides which extensions count; extensionless files never do', () => {
    const fs = memoryFs('win32', {
      ...NPM_WINDOWS,
      'C:\\tools\\bh': { bytes: utf8('not runnable from cmd') },
      'C:\\tools\\bh.vbs': { bytes: utf8('WScript.Echo "hi"') },
    });
    const env = { PATH: `C:\\tools;${NPM_PREFIX}` };
    expect(findShorthand({ platform: 'win32', env: { ...env, PATHEXT: '.EXE;.CMD' }, fs })).toEqual(
      { kind: 'browserhive', path: `${NPM_PREFIX}\\bh.ps1` },
    );
    expect(
      findShorthand({ platform: 'win32', env: { ...env, PATHEXT: '.EXE;.CMD;.VBS' }, fs }),
    ).toEqual({ kind: 'other', path: 'C:\\tools\\bh.vbs' });
  });

  it('a Bun .exe without its .bunx is other', () => {
    const fs = memoryFs('win32', { 'C:\\bin\\bh.exe': { bytes: BUN_EXE } });
    expect(findShorthand({ platform: 'win32', env: { PATH: 'C:\\bin' }, fs }).kind).toBe('other');
  });
});
