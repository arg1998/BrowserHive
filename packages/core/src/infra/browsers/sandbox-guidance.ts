/** @module infra/browsers/sandbox-guidance — what to tell an operator whose browser cannot run with Chromium's sandbox: the cause on this OS and the ways out, working options first (plan §3.4.1). Pure: every fact is an input. */

import type { Channel } from '@browserhive/contracts/enums';
import { APPARMOR_DIR, APPARMOR_PROFILE_NAME, type SandboxEnvironment } from './sandbox.ts';

/** The browser that could not sandbox. */
export interface GuidanceTarget {
  readonly channel: Channel;
  readonly label: string;
  readonly source: 'bundled' | 'installed';
  readonly version: string | null;
  readonly executablePath: string | null;
}

/** Another channel on this host and whether it sandboxes (probed, not assumed). */
export interface GuidanceAlternative {
  readonly channel: Channel;
  readonly label: string;
  readonly state: 'works' | 'unavailable' | 'not-installed' | 'broken' | 'unknown';
}

/** Inputs of {@link sandboxGuidance}. */
export interface SandboxGuidanceInput {
  readonly target: GuidanceTarget;
  /** Chrome's own one-line reason. */
  readonly reason: string;
  readonly env: SandboxEnvironment;
  /** Whether an AppArmor profile names the target's path (null: not Linux / unknown). */
  readonly apparmorCovered: boolean | null;
  readonly alternatives: readonly GuidanceAlternative[];
  /**
   * Who required the sandbox: the operator's `sandbox=on` (with how it was set, e.g. `--sandbox on`),
   * or an agent's `launch_options.chromiumSandbox: true`.
   */
  readonly requiredBy:
    | { readonly kind: 'config'; readonly setting: string }
    | { readonly kind: 'launch_options' };
}

/** One way out: a sentence and the commands that do it. */
export interface GuidanceOption {
  readonly text: string;
  readonly commands: readonly string[];
}

/** The computed guidance. */
export interface SandboxGuidance {
  /** Why this OS refuses, in one or two sentences, or null when nothing specific was detected. */
  readonly cause: string | null;
  /** Ways out, easiest first. */
  readonly options: readonly GuidanceOption[];
  /** Other channels that were checked and do sandbox here. */
  readonly workingChannels: readonly Channel[];
}

const ISSUES_URL = 'https://github.com/arg1998/BrowserHive/issues';

/** The OS-level cause, from the detected conditions. */
function causeOf(input: SandboxGuidanceInput): string | null {
  const { env } = input;
  if (env.root) {
    return `Chrome refuses to run sandboxed as root (uid 0)${env.container ? ', and this is a container' : ''}.`;
  }
  if (env.apparmorRestrictsUserns) {
    const distro = env.distro ?? 'This Linux';
    const coverage =
      input.apparmorCovered === true
        ? 'A profile names this path, so something else is blocking it.'
        : 'No profile covers this path.';
    return `${distro} restricts unprivileged user namespaces to programs with an AppArmor profile (kernel.apparmor_restrict_unprivileged_userns=1). ${coverage}`;
  }
  if (env.usernsCloneDisabled) {
    return 'The kernel disables unprivileged user namespaces (kernel.unprivileged_userns_clone=0).';
  }
  if (env.userNamespacesDisabled) {
    return 'User namespaces are disabled on this host (user.max_user_namespaces=0).';
  }
  if (env.container) {
    return "This is a container; Docker's default seccomp profile blocks the namespaces Chromium's sandbox needs.";
  }
  return null;
}

/**
 * Guidance for a browser that cannot sandbox, specific to this OS and these browsers. Options that
 * were checked to work come first; generic fallbacks last.
 *
 * @returns The cause, the options and the channels that do sandbox here.
 */
export function sandboxGuidance(input: SandboxGuidanceInput): SandboxGuidance {
  const { target, env } = input;
  const options: GuidanceOption[] = [];
  const working = input.alternatives.filter(
    (a) => a.state === 'works' && a.channel !== target.channel,
  );
  const config = input.requiredBy.kind === 'config';

  for (const alt of working) {
    options.push({
      text: `Use the installed ${alt.label}. It can run sandboxed on this machine (checked):`,
      commands: [
        config
          ? `browserhive --sandbox on --defaultChannel ${alt.channel}`
          : `launch_session with channel: '${alt.channel}'`,
      ],
    });
  }

  if (env.root) {
    options.push({
      text: env.container
        ? "Run the container as a normal user (docker run --user 1000:1000 …) with Playwright's seccomp profile (--security-opt seccomp=seccomp_profile.json, see the Playwright Docker docs)."
        : 'Run BrowserHive as a normal user; Chrome refuses to sandbox as root.',
      commands: [],
    });
  } else if (env.apparmorRestrictsUserns && input.apparmorCovered !== true) {
    const profile =
      target.channel === 'chromium' ? APPARMOR_PROFILE_NAME : `browserhive-${target.channel}`;
    const printFlag =
      target.channel === 'chromium'
        ? 'browserhive doctor --printApparmorProfile'
        : `browserhive doctor --printApparmorProfile --defaultChannel ${target.channel}`;
    options.push({
      text:
        target.source === 'bundled'
          ? 'Keep the bundled browser and give it an AppArmor profile (one-time, needs sudo; redo after each BrowserHive browser update):'
          : `Give ${target.label} an AppArmor profile (one-time, needs sudo):`,
      commands: [
        `${printFlag} | sudo tee ${APPARMOR_DIR}/${profile}`,
        `sudo apparmor_parser -r ${APPARMOR_DIR}/${profile}`,
      ],
    });
  } else if (env.usernsCloneDisabled) {
    options.push({
      text: 'Allow unprivileged user namespaces (needs sudo; add it to /etc/sysctl.d to keep it after a reboot):',
      commands: ['sudo sysctl -w kernel.unprivileged_userns_clone=1'],
    });
  } else if (env.userNamespacesDisabled) {
    options.push({
      text: 'Enable user namespaces (needs sudo; add it to /etc/sysctl.d to keep it after a reboot):',
      commands: ['sudo sysctl -w user.max_user_namespaces=15000'],
    });
  } else if (env.container) {
    options.push({
      text: "Run the container with Playwright's seccomp profile (--security-opt seccomp=seccomp_profile.json, see the Playwright Docker docs).",
      commands: [],
    });
  }

  const chrome = input.alternatives.find((a) => a.channel === 'chrome');
  if (
    target.channel !== 'chrome' &&
    chrome?.state === 'not-installed' &&
    !env.root &&
    (env.platform === 'linux' || env.platform === 'darwin' || env.platform === 'win32')
  ) {
    options.push({
      text:
        env.platform === 'linux'
          ? "Install Google Chrome (needs administrator rights). Ubuntu ships an AppArmor profile for it, so it usually sandboxes; 'browserhive doctor' confirms:"
          : 'Install Google Chrome (needs administrator rights):',
      commands: ['browserhive init --installChrome'],
    });
  }

  if (env.platform === 'darwin' || env.platform === 'win32') {
    options.push({
      text: `The sandbox is expected to work on ${env.platform === 'darwin' ? 'macOS' : 'Windows'}. Please report this with the output of 'browserhive doctor --json': ${ISSUES_URL}`,
      commands: [],
    });
  }

  if (config) {
    options.push({
      text: 'Sandbox where possible, fall back where not:',
      commands: ['--sandbox auto'],
    });
    options.push({ text: 'Run without the sandbox, as before:', commands: ['--sandbox off'] });
  } else {
    options.push({ text: 'Launch without launch_options.chromiumSandbox.', commands: [] });
  }

  return { cause: causeOf(input), options, workingChannels: working.map((a) => a.channel) };
}

/** Word-wraps `text` to `width` columns. */
export function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/)) {
    if (word === '') continue;
    if (current !== '' && current.length + 1 + word.length > width) {
      lines.push(current);
      current = word;
    } else {
      current = current === '' ? word : `${current} ${word}`;
    }
  }
  if (current !== '') lines.push(current);
  return lines;
}

const WIDTH = 96;

function field(label: string, text: string): string[] {
  const indent = ' '.repeat(12);
  return wrap(text, WIDTH - 12).map((line, i) =>
    i === 0 ? `  ${label.padEnd(10)}${line}` : `${indent}${line}`,
  );
}

/**
 * The operator-facing block printed under the error's first line (boot refusal, `doctor`): the
 * browser, Chrome's reason, the OS cause and the numbered options.
 *
 * @returns Lines without trailing newlines.
 */
export function renderSandboxGuidance(
  input: SandboxGuidanceInput,
  guidance: SandboxGuidance,
): string[] {
  const { target } = input;
  const product =
    target.source === 'bundled'
      ? `bundled ${target.label}${target.version === null ? '' : ` ${target.version}`}`
      : `${target.label}${target.version === null ? '' : ` ${target.version}`}`;
  const lines: string[] = [''];
  lines.push(...field('browser', `${target.channel} (${product})`));
  if (target.executablePath !== null) lines.push(`${' '.repeat(12)}${target.executablePath}`);
  lines.push(...field('reason', `${input.reason} (Chrome's own message)`));
  if (guidance.cause !== null) lines.push(...field('cause', guidance.cause));
  lines.push('', 'What you can do, easiest first:');
  const commandWidth = Math.max(
    0,
    ...guidance.options
      .filter((o) => o.commands.length === 1 && (o.commands[0] ?? '').startsWith('--'))
      .map((o) => o.text.length),
  );
  guidance.options.forEach((option, index) => {
    const number = `  ${index + 1}. `;
    const only = option.commands[0];
    if (option.commands.length === 1 && only?.startsWith('--') === true) {
      // Short flag-only options fit on one line, aligned like a table.
      lines.push(`${number}${option.text.padEnd(commandWidth + 1)} ${only}`);
      return;
    }
    const text = wrap(option.text, WIDTH - number.length);
    text.forEach((line, i) => {
      lines.push(i === 0 ? `${number}${line}` : `${' '.repeat(number.length)}${line}`);
    });
    for (const command of option.commands) lines.push(`${' '.repeat(number.length + 2)}${command}`);
  });
  return lines;
}

/**
 * The short form for a tool error an agent reads: which channels work here, else who to ask.
 *
 * @returns One or two sentences.
 */
export function shortSandboxGuidance(
  input: SandboxGuidanceInput,
  guidance: SandboxGuidance,
): string[] {
  const lines: string[] = [];
  if (guidance.workingChannels.length > 0) {
    lines.push(
      `Use channel ${guidance.workingChannels.map((c) => `'${c}'`).join(' or ')}, which runs sandboxed on this host.`,
    );
  } else {
    lines.push("Ask the operator to run 'browserhive doctor' for the options on this host.");
  }
  if (input.requiredBy.kind === 'launch_options') {
    lines.push('Or launch without launch_options.chromiumSandbox.');
  }
  return lines;
}
