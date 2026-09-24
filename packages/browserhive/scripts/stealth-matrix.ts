/**
 * @module scripts/stealth-matrix — measures sandbox viability and the page-visible stealth signals per
 * channel × stealth level × sandbox mode, through BrowserHive (plan §5 Phase 0, §6).
 *
 * Usage:
 *   bun packages/browserhive/scripts/stealth-matrix.ts \
 *     [--channels chromium,chrome,edge] [--stealth standard,max] [--sandbox off,session] \
 *     [--out matrix.json] [--summary "$GITHUB_STEP_SUMMARY"] [--strict]
 *
 * Exit code: 0 unless `--strict` and a launched row failed a §6 check or broke sandbox parity.
 * Rows for channels that are not installed are reported as skipped, never as passed.
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import {
  hostFacts,
  type ProbeChannel,
  type ProbeRow,
  type ProbeSandbox,
  type ProbeStealth,
  parityProblems,
  rawSandboxError,
  runMatrix,
} from '../test/stealth/probe.ts';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
}

function list<T extends string>(name: string, fallback: readonly T[], allowed: readonly T[]): T[] {
  const raw = arg(name);
  if (raw === undefined) return [...fallback];
  const values = raw.split(',').map((v) => v.trim());
  for (const value of values) {
    if (!(allowed as readonly string[]).includes(value)) {
      console.error(`stealth-matrix: --${name} ${value} is not one of ${allowed.join(', ')}`);
      process.exit(64);
    }
  }
  return values as T[];
}

const channels = list<ProbeChannel>(
  'channels',
  ['chromium', 'chrome', 'edge'],
  ['chromium', 'chrome', 'edge'],
);
const stealth = list<ProbeStealth>('stealth', ['standard', 'max'], ['standard', 'max']);
const sandbox = list<ProbeSandbox>(
  'sandbox',
  ['off', 'session'],
  ['off', 'session', 'config:auto', 'config:on', 'config:off'],
);
const strict = process.argv.includes('--strict');

const facts = hostFacts();
console.log(`host: ${JSON.stringify(facts)}`);

function sandboxCell(row: ProbeRow): string {
  if (row.outcome === 'skipped') return 'skipped (not installed)';
  if (row.outcome === 'failed') return `FAILED ${row.errorCode ?? ''} (${row.retryable ?? ''})`;
  if (row.sandboxed === null) return 'launched (processes not visible)';
  return row.sandboxed ? 'sandboxed' : 'unsandboxed';
}

function brandsCell(row: ProbeRow): string {
  return row.signals?.brands?.join(', ') ?? '';
}

const rows = await runMatrix({
  channels,
  stealth,
  sandbox,
  onRow: (row) => {
    const verdict = row.problems.length === 0 ? 'ok' : row.problems.join('; ');
    console.log(
      `${row.channel} ${row.stealth} sandbox=${row.sandbox}: ${sandboxCell(row)} · ${row.launchMs ?? '-'} ms · ${verdict}`,
    );
    if (row.outcome === 'failed') console.log(`  error: ${row.errorMessage ?? ''}`);
  },
});
const parity = parityProblems(rows);
for (const problem of parity) console.log(`parity: ${problem}`);

const header =
  '| OS | channel | engine | stealth | sandbox request | result | launch ms | brands | UA | fullVersionList | webdriver | chrome | plugins | pdf | H.264/AAC | screen | WebGL | notifications (query/permission) | §6 problems |';
const divider = `|${'---|'.repeat(19)}`;
const md = [
  `### Stealth and sandbox matrix · ${facts.platform} ${facts.release}`,
  '',
  `Host: uid=${facts.uid ?? 'n/a'} · apparmor_restrict_unprivileged_userns=${facts.apparmorRestrictUserns ?? 'n/a'} · unprivileged_userns_clone=${facts.unprivilegedUsernsClone ?? 'n/a'} · container=${facts.container}`,
  '',
  header,
  divider,
  ...rows.map((row) => {
    const s = row.signals;
    const cells = [
      facts.platform,
      row.channel,
      row.engineVersion ?? 'n/a',
      row.stealth,
      row.sandbox,
      sandboxCell(row),
      String(row.launchMs ?? ''),
      brandsCell(row),
      s?.ua ?? '',
      s?.fullVersionList?.join(', ') ?? '',
      String(s?.webdriver ?? ''),
      s?.chrome ?? '',
      String(s?.plugins ?? ''),
      String(s?.pdfViewerEnabled ?? ''),
      s === null ? '' : `${s.h264}/${s.aac}`,
      s?.screen ?? '',
      s?.webgl ?? '',
      s === null ? '' : `${s.notificationsQuery ?? ''}/${s.notificationPermission ?? ''}`,
      row.outcome === 'launched'
        ? row.problems.length === 0
          ? 'none'
          : row.problems.join('; ')
        : (row.errorMessage ?? '').replace(/\s+/g, ' ').slice(0, 300),
    ];
    return `| ${cells.map((c) => c.replace(/\|/g, '\\|')).join(' | ')} |`;
  }),
  '',
  parity.length === 0
    ? 'Sandbox parity: every sandboxed row reports the same page-visible signals as its unsandboxed row.'
    : `Sandbox parity problems:\n${parity.map((p) => `- ${p}`).join('\n')}`,
  '',
].join('\n');

// Diagnostics: the raw error text of every channel whose sandbox failed, for the classifier.
const failedChannels = [
  ...new Set(
    rows
      .filter(
        (r) =>
          r.outcome === 'failed' ||
          (r.sandbox !== 'off' && r.sandbox !== 'config:off' && r.sandboxed === false),
      )
      .map((r) => r.channel),
  ),
];
const raw: string[] = [];
for (const channel of failedChannels) {
  const text = await rawSandboxError(channel);
  if (text !== null)
    raw.push(
      `<details><summary>${channel}: raw sandboxed launch error</summary>\n\n\`\`\`\n${text}\n\`\`\`\n</details>`,
    );
}
if (raw.length > 0) console.log(raw.join('\n'));

const out = arg('out');
if (out !== undefined) writeFileSync(out, `${JSON.stringify({ facts, rows, parity }, null, 2)}\n`);
const summary = arg('summary');
if (summary !== undefined && summary !== '') appendFileSync(summary, `${md}\n${raw.join('\n')}\n`);
console.log(md);

const failedChecks = rows.some((r) => r.outcome === 'launched' && r.problems.length > 0);
if (strict && (failedChecks || parity.length > 0)) process.exit(1);
