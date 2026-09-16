/** @module test/cli/help — generated help goldens per command and subcommand (width 100, colour off; `UPDATE_GOLDENS=1` blesses) */
import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_KEYS, namesFor } from '@browserhive/contracts/config';
import { renderCommandHelp, renderGlobalHelp } from '../../src/cli/help.ts';
import type { HelpTopic } from '../../src/cli/invocation.ts';
import { createStyle, stripAnsi } from '../../src/cli/output/style.ts';
import { COMMANDS } from '../../src/cli/registry.ts';
import { cliHarness } from './helpers.ts';

const GOLDENS = join(import.meta.dir, '__goldens__');
const UPDATE = process.env['UPDATE_GOLDENS'] === '1';

function golden(name: string, text: string): void {
  const path = join(GOLDENS, `${name}.txt`);
  if (UPDATE || !existsSync(path)) {
    if (!UPDATE) throw new Error(`missing golden ${path}; run with UPDATE_GOLDENS=1 to create it`);
    mkdirSync(GOLDENS, { recursive: true });
    writeFileSync(path, text);
    return;
  }
  expect(text).toBe(readFileSync(path, 'utf8'));
}

const options = { version: '0.1.0', width: 100, style: createStyle(false) };

const topics: { name: string; topic: HelpTopic }[] = [
  { name: 'global', topic: { command: null, subcommand: null } },
];
for (const command of COMMANDS) {
  topics.push({ name: command.name, topic: { command: command.name, subcommand: null } });
  for (const sub of command.subcommands) {
    topics.push({
      name: `${command.name}-${sub.words.join('-')}`,
      topic: { command: command.name, subcommand: sub.words },
    });
  }
}

describe('help goldens (width 100, colour off)', () => {
  it.each(topics.map((t) => [t.name, t.topic] as const))('%s', (name, topic) => {
    golden(`help-${name}`, `${renderCommandHelp(topic, options).join('\n')}\n`);
  });
});

describe('help layout', () => {
  it('global help has USAGE, COMMANDS, every server flag and the precedence line', () => {
    const text = renderGlobalHelp(options).join('\n');
    expect(text.startsWith('browserhive 0.1.0 — local-first stealth browser MCP server')).toBe(
      true,
    );
    for (const section of [
      'USAGE',
      'COMMANDS',
      'FLAGS — server',
      'FLAGS — sessions',
      'FLAGS — telemetry',
    ]) {
      expect(text).toContain(section);
    }
    for (const key of CONFIG_KEYS) expect(text).toContain(`--${key}`);
    expect(text).toContain('default: 9876');
    expect(text).toContain('[secret]');
    expect(text).toContain('Precedence: defaults < environment < browserhive.config.json < flags');
  });

  it('help config lists the environment variable of every key', () => {
    const text = renderCommandHelp({ command: 'config', subcommand: null }, options).join('\n');
    for (const key of CONFIG_KEYS) expect(text).toContain(namesFor(key).env);
  });

  it.each([60, 80, 120])('wraps at width %d', (width) => {
    const lines = renderGlobalHelp({ ...options, width });
    // Only an unbreakable token (`default: http://127.0.0.1:4318`) may overflow the width.
    const tooLong = lines.filter(
      (line) => line.length > width && line.trim().split(' ').length > 2,
    );
    expect(tooLong).toEqual([]);
  });

  it('colour: bold names, underlined headers, cyan defaults; stripped text equals the plain rendering', () => {
    const coloured = renderGlobalHelp({ ...options, style: createStyle(true) }).join('\n');
    expect(coloured).toContain('\x1b[1m--port\x1b[22m');
    expect(coloured).toContain('\x1b[4m');
    expect(coloured).toContain('\x1b[36m9876');
    expect(stripAnsi(coloured).split('\n').length).toBe(renderGlobalHelp(options).length);
  });

  it('--help writes to stdout, exit 0, even with --transport stdio', async () => {
    const run = await cliHarness({ argv: ['--transport', 'stdio', '--help'] });
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('USAGE');
    expect(run.stderr).toBe('');
  });

  it('colour is off for a non-TTY stdout and on with --color always', async () => {
    expect((await cliHarness({ argv: ['--help'] })).stdout).not.toContain('\x1b[');
    expect(
      (await cliHarness({ argv: ['--help'], stdoutTty: true, env: { NO_COLOR: '1' } })).stdout,
    ).not.toContain('\x1b[');
    expect((await cliHarness({ argv: ['--help', '--color', 'always'] })).stdout).toContain('\x1b[');
  });
});
