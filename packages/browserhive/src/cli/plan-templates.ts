/** @module cli/plan-templates — the `templates` subcommands' flags → their invocations, with the cheap local checks (`create`'s flags, `restore`'s version, `host`'s action) as usage errors (spec 13 §7.2, §11.5) */
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { Channel, StealthLevel } from '@browserhive/contracts/enums';
import {
  TEMPLATE_MAX_CONCURRENT,
  TEMPLATE_SITES_MAX,
  type TemplateInput,
  TemplateName,
  type TemplatePolicyInput,
  type TemplateProxyInput,
  TemplateSiteHost,
} from '@browserhive/contracts/http';
import type { TokenizedArgs } from '@browserhive/core/config';
import {
  type Invocation,
  type RemoteTarget,
  TEMPLATE_HOST_ACTIONS,
  type TemplateHostAction,
  type TemplateTarget,
} from './invocation.ts';
import type { FlagReader } from './plan-args.ts';

/** `--timeout` default of `templates create`: 30 minutes. */
export const TEMPLATE_CREATE_TIMEOUT_MS = 30 * 60_000;

/** An invocation waiting for its REST target (resolved after the flags are known to be valid). */
export type RemoteInvocation = (remote: RemoteTarget) => Invocation;

/** What the planner hands over: the flag reader, the raw tokens (repeatable flags) and positionals. */
export interface TemplatesPlanInput {
  readonly reader: FlagReader;
  readonly tokens: TokenizedArgs;
  readonly args: readonly string[];
  /** The working directory (relative file arguments). */
  readonly cwd: string;
}

/**
 * Reads one `templates` subcommand's flags. Problems are collected in `reader.problems`; the
 * caller turns them into a usage error (64) before using the result.
 *
 * @returns The invocation builder.
 */
export function templatesInvocation(name: string, input: TemplatesPlanInput): RemoteInvocation {
  const { reader, args } = input;
  const json = reader.bool('json');
  const templateName = args[0] ?? '';
  const target = (remote: RemoteTarget): TemplateTarget => ({ name: templateName, json, remote });
  switch (name) {
    case 'templates list':
      return (remote) => ({ command: 'templates-list', json, remote });
    case 'templates finish':
      return (remote) => ({ command: 'templates-finish', name: templateName, json, remote });
    case 'templates create':
      return createInvocation(input, templateName, json);
    case 'templates show':
      return (remote) => ({ command: 'templates-show', ...target(remote) });
    case 'templates versions':
      return (remote) => ({ command: 'templates-versions', ...target(remote) });
    case 'templates save':
      return (remote) => ({ command: 'templates-save', ...target(remote) });
    case 'templates disable':
      return (remote) => ({ command: 'templates-disable', ...target(remote) });
    case 'templates enable':
      return (remote) => ({ command: 'templates-enable', ...target(remote) });
    case 'templates seed': {
      const file = absolutePath(input, args[1] ?? '');
      const yes = reader.bool('yes');
      return (remote) => ({ command: 'templates-seed', file, yes, ...target(remote) });
    }
    case 'templates restore': {
      const version = versionArgument(reader, args[1] ?? '');
      const forceClose = reader.bool('forceClose');
      const yes = reader.bool('yes');
      return (remote) => ({
        command: 'templates-restore',
        version,
        forceClose,
        yes,
        ...target(remote),
      });
    }
    case 'templates host': {
      const action = hostAction(reader, args[1] ?? '');
      return (remote) => ({ command: 'templates-host', action, ...target(remote) });
    }
    default: {
      const force = reader.bool('force');
      const yes = reader.bool('yes');
      return (remote) => ({
        command: 'templates-rm',
        name: templateName,
        force,
        yes,
        json,
        remote,
      });
    }
  }
}

/** A path argument or flag, resolved against the working directory. */
function absolutePath(input: TemplatesPlanInput, raw: string): string {
  return isAbsolute(raw) ? raw : resolvePath(input.cwd, raw);
}

/** `<version|latest>` of `templates restore`: a positive whole number or `latest`. */
function versionArgument(reader: FlagReader, raw: string): number | 'latest' {
  if (raw === 'latest') return 'latest';
  if (/^[1-9][0-9]{0,8}$/.test(raw)) return Number(raw);
  reader.problems.push(
    `invalid version '${raw}'. Expected a version number from 'templates versions', or latest (the rolling checkpoint).`,
  );
  return 'latest';
}

function hostAction(reader: FlagReader, raw: string): TemplateHostAction {
  const found = TEMPLATE_HOST_ACTIONS.find((action) => action === raw);
  if (found !== undefined) return found;
  reader.problems.push(
    raw === ''
      ? "'templates host' requires an action: start, stop or restart."
      : `unknown action '${raw}' for 'templates host'. Expected one of: start, stop, restart.`,
  );
  return 'start';
}

function createInvocation(
  input: TemplatesPlanInput,
  name: string,
  json: boolean,
): RemoteInvocation {
  const { reader } = input;
  if (!TemplateName.safeParse(name).success) {
    reader.problems.push(
      `invalid template name '${name}'. Expected 2–32 characters: a–z first, then a–z, 0–9 or -.`,
    );
  }
  const sites = siteList(reader);
  const noLogin = reader.bool('noLogin');
  const timeoutMs = reader.duration('timeout') ?? TEMPLATE_CREATE_TIMEOUT_MS;
  const displayName = reader.text('displayName');
  const description = reader.text('description');
  const channel = Channel.safeParse(reader.oneOf('channel', Channel.options)).data;
  const stealth = StealthLevel.safeParse(reader.oneOf('stealth', StealthLevel.options)).data;
  const headless = input.tokens.flags.has('headless') ? reader.bool('headless') : undefined;
  const locale = reader.text('locale');
  const timezone = reader.text('timezone');
  const proxy = proxyInput(reader);
  const policy = policyInput(input);
  const fromStateRaw = reader.text('fromState');
  const fromState = fromStateRaw === undefined ? null : absolutePath(input, fromStateRaw);
  if (fromState !== null && reader.bool('noLogin')) {
    reader.problems.push('--fromState and --noLogin are mutually exclusive: pass one.');
  }
  const body: TemplateInput = {
    name,
    sites: sites.map((site) => ({ site_id: site })),
    ...(displayName !== undefined && { display_name: displayName }),
    ...(description !== undefined && { description }),
    ...(channel !== undefined && { channel }),
    ...(headless !== undefined && { headless }),
    ...(stealth !== undefined && { stealth }),
    ...(proxy !== undefined && { proxy }),
    ...(locale !== undefined && { locale }),
    ...(timezone !== undefined && { timezone_id: timezone }),
    ...(policy !== undefined && { policy }),
  };
  return (remote) => ({
    command: 'templates-create',
    name,
    input: body,
    noLogin,
    timeoutMs,
    fromState,
    json,
    remote,
  });
}

/** `--sites a.com,b.com`: required, trimmed, lower-cased, de-duplicated domains. */
function siteList(reader: FlagReader): readonly string[] {
  const raw = reader.text('sites');
  if (raw === undefined) {
    reader.problems.push(
      "'templates create' requires --sites <site,…>, e.g. --sites linkedin.com,indeed.com.",
    );
    return [];
  }
  const sites = [
    ...new Set(
      raw
        .split(',')
        .map((site) => site.trim().toLowerCase())
        .filter((site) => site !== ''),
    ),
  ];
  if (sites.length === 0) reader.problems.push('--sites needs at least one site.');
  if (sites.length > TEMPLATE_SITES_MAX) {
    reader.problems.push(`--sites takes at most ${TEMPLATE_SITES_MAX} sites.`);
  }
  for (const site of sites) {
    if (!TemplateSiteHost.safeParse(site).success) {
      reader.problems.push(
        `invalid site '${site}' in --sites. Expected a domain like linkedin.com.`,
      );
    }
  }
  return sites;
}

/** `--proxy` with its optional user name and password variable (both need `--proxy`). */
function proxyInput(reader: FlagReader): TemplateProxyInput | undefined {
  const server = reader.text('proxy');
  const username = reader.text('proxyUsername');
  const passwordEnv = reader.text('proxyPasswordEnv');
  if (server === undefined) {
    if (username !== undefined) reader.problems.push('--proxyUsername requires --proxy.');
    if (passwordEnv !== undefined) reader.problems.push('--proxyPasswordEnv requires --proxy.');
    return undefined;
  }
  return {
    server,
    ...(username !== undefined && { username }),
    ...(passwordEnv !== undefined && { password_env: passwordEnv }),
  };
}

/** `--maxConcurrent` and the access choice (`--allPrincipals` = `[]`, or every `--principal`). */
function policyInput(input: TemplatesPlanInput): TemplatePolicyInput | undefined {
  const { reader } = input;
  const maxConcurrent = maxConcurrentFlag(reader);
  const all = reader.bool('allPrincipals');
  const raw = input.tokens.flags.get('principal') ?? [];
  const principals = [...new Set(raw.map((value) => value.trim()))];
  if (principals.includes('')) reader.problems.push('--principal is set but empty.');
  if (all && raw.length > 0) {
    reader.problems.push('--allPrincipals and --principal are mutually exclusive: pass one.');
  }
  const authorized = all ? [] : principals.length > 0 ? principals : undefined;
  if (maxConcurrent === undefined && authorized === undefined) return undefined;
  return {
    ...(maxConcurrent !== undefined && { max_concurrent: maxConcurrent }),
    ...(authorized !== undefined && { authorized_principals: authorized }),
  };
}

function maxConcurrentFlag(reader: FlagReader): number | undefined {
  const raw = reader.text('maxConcurrent');
  if (raw === undefined) return undefined;
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  const { min, max } = TEMPLATE_MAX_CONCURRENT;
  if (Number.isInteger(value) && value >= min && value <= max) return value;
  reader.problems.push(
    `invalid value for --maxConcurrent: '${raw}'. Expected a whole number from ${min} to ${max}.`,
  );
  return undefined;
}
