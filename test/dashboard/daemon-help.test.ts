/** @module test/dashboard/daemon-help — the dashboard's help commands (04 §18.6.3) name real CLI commands, subcommands and config-key flags. Lives outside `packages/` so it may read both the dashboard and the CLI registry. */
import { describe, expect, it } from 'bun:test';
import { CONFIG_KEYS } from '@browserhive/contracts/config';
import {
  acceptedFlags,
  COMMAND_NAMES,
  type CommandName,
  commandDescriptor,
  isCommandName,
} from '../../packages/browserhive/src/cli/registry.ts';
import {
  daemonHelp,
  type HelpCommand,
  type HelpLocation,
  helpCommandsFor,
} from '../../packages/dashboard/src/lib/daemon-help/commands.ts';
import { classifyProbe } from '../../packages/dashboard/src/lib/daemon-help/probe.ts';

function at(url: string): HelpLocation {
  const { protocol, hostname, port, host } = new URL(url);
  return { protocol, hostname, port, host };
}

/** Every BrowserHive command the help can emit, across ports, hosts and versions. */
function emittedCommands(): readonly HelpCommand[] {
  const out: HelpCommand[] = [];
  for (const url of ['http://127.0.0.1:9876/', 'http://localhost:8080/', 'https://hive.example/']) {
    for (const lastSeenVersion of [null, '0.2.2']) {
      const help = daemonHelp({ location: at(url), platform: null, lastSeenVersion });
      out.push(...helpCommandsFor(help, 'not-running'));
    }
  }
  return out.filter((c) => /^(bunx )?browserhive(@\S+)? ?/.test(c.command));
}

/** Splits `browserhive config show --port 1` into words and `--flag[=value]` names. */
function parse(command: string): { words: string[]; flags: string[] } {
  const tokens = command.split(' ');
  if (tokens[0] === 'bunx') tokens.shift();
  tokens.shift(); // browserhive or browserhive@<v>
  const words: string[] = [];
  const flags: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? '';
    if (token.startsWith('--')) {
      flags.push(token.slice(2));
      if (token === '--port') i += 1; // its value
    } else words.push(token);
  }
  return { words, flags };
}

describe('daemon help commands match the CLI', () => {
  it('emits the start, doctor and config show commands', () => {
    const texts = new Set(emittedCommands().map((c) => c.command));
    expect(texts.has('browserhive --admin')).toBe(true);
    expect(texts.has('browserhive --admin --port 8080')).toBe(true);
    expect(texts.has('bunx browserhive@0.2.2 --admin')).toBe(true);
    expect(texts.has('browserhive doctor')).toBe(true);
    expect(texts.has('browserhive config show')).toBe(true);
  });

  it('every command word is in COMMAND_NAMES and every subcommand exists as written', () => {
    for (const { command } of emittedCommands()) {
      const { words } = parse(command);
      const name: CommandName = words[0] === undefined ? 'serve' : (words[0] as CommandName);
      expect({ command, known: isCommandName(name) }).toEqual({ command, known: true });
      expect(COMMAND_NAMES).toContain(name);
      const rest = words.slice(1);
      if (rest.length === 0) continue;
      const subcommands = commandDescriptor(name).subcommands.map((s) => s.words.join(' '));
      expect(subcommands).toContain(rest.join(' '));
    }
  });

  it('--admin and --port are config keys the command accepts', () => {
    expect(CONFIG_KEYS).toContain('admin');
    expect(CONFIG_KEYS).toContain('port');
    for (const { command } of emittedCommands()) {
      const { words, flags } = parse(command);
      const descriptor = commandDescriptor(
        words[0] === undefined ? 'serve' : (words[0] as CommandName),
      );
      const accepted = acceptedFlags(descriptor, undefined);
      for (const flag of flags) {
        expect({
          command,
          flag,
          isConfigKey: (CONFIG_KEYS as readonly string[]).includes(flag),
        }).toEqual({ command, flag, isConfigKey: true });
        expect(accepted.configKeys.has(flag as (typeof CONFIG_KEYS)[number])).toBe(true);
      }
    }
  });
});

describe('daemon-help loads in the server test project (no DOM preload)', () => {
  it('probe.ts evaluates and runs outside the dashboard project', () => {
    expect(classifyProbe({ kind: 'rejected' }, { online: true })).toBe('not-running');
  });
});
