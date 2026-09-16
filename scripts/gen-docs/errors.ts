/** @module scripts/gen-docs/errors — renders docs/reference/errors.md from the contracts error registry */
import {
  ERROR_CODES,
  ERROR_REGISTRY,
  ErrorCategory,
  type ErrorCode,
  errorDocsUrl,
  Retryable,
} from '@browserhive/contracts/errors';
import { z } from 'zod';
import {
  anchor,
  describeConstraints,
  describeType,
  document,
  GENERATED_HEADER,
  inlineCode,
  objectFields,
  table,
} from './markdown.ts';

const CATEGORY_TEXT: Readonly<Record<ErrorCategory, readonly [string, string]>> = {
  domain: [
    'Domain errors',
    'Returned by tools and the REST API when a request cannot be served (unknown session, blocked URL, vault locked…).',
  ],
  boot: [
    'Boot errors',
    'Stop the process before it serves anything. The CLI prints `[CODE] message` and exits with the listed exit code.',
  ],
  auth: ['Authentication errors', 'Returned by the REST API, `/mcp` and the WebSocket handshake.'],
  transport: [
    'Transport errors',
    'Protocol-level failures of HTTP and WebSocket requests (validation, limits, conflicts).',
  ],
  audit: [
    'Audit outcomes',
    'Recorded in the audit trail (vault log, attention history). Some are also returned inside a tool result.',
  ],
  warning: [
    'Warnings',
    'Non-fatal degradations recorded on a session or in the system events list; the operation continues.',
  ],
};

const RETRYABLE_TEXT: Readonly<Record<Retryable, string>> = {
  never: 'do not retry; the request cannot succeed as sent',
  immediate: 'safe to retry right away',
  backoff: 'retry later with backoff',
  after_operator:
    'retry after an operator acts (unlock the vault, resolve a request, change policy)',
  different_args: 'retry only with different arguments',
};

function codeAnchorLink(code: ErrorCode): string {
  return `[${inlineCode(code)}](#${code})`;
}

function detailsTable(code: ErrorCode): string {
  const schema = z.toJSONSchema(ERROR_REGISTRY[code].details, {
    io: 'output',
    unrepresentable: 'any',
  });
  const fields = objectFields(schema);
  if (fields.length === 0) return 'Details: none.';
  return [
    'Details:',
    '',
    table(
      ['Field', 'Type', 'Required', 'Constraints'],
      fields.map((f) => [
        inlineCode(f.name),
        describeType(f.schema),
        f.required ? 'yes' : 'no',
        describeConstraints(f.schema).join('; ') || '—',
      ]),
    ),
  ].join('\n');
}

function codeSection(code: ErrorCode): string {
  const spec = ERROR_REGISTRY[code];
  const facts: string[][] = [
    ['Title', spec.title],
    ['HTTP status', String(spec.httpStatus)],
    ['Category', inlineCode(spec.category)],
    ['Retryable', `${inlineCode(spec.retryable)} (${RETRYABLE_TEXT[spec.retryable]})`],
  ];
  if (spec.exitCode !== undefined) facts.push(['Exit code', String(spec.exitCode)]);
  const lines = [
    anchor(code),
    `### ${inlineCode(code)}`,
    '',
    table(['Property', 'Value'], facts),
    '',
    `Message: ${inlineCode(spec.message)}`,
  ];
  if (spec.hint !== undefined) lines.push('', `Hint: ${spec.hint}`);
  if (spec.cause !== undefined) lines.push('', `Cause: ${spec.cause}`);
  if (spec.resolution !== undefined) lines.push('', `Resolution: ${spec.resolution}`);
  lines.push('', detailsTable(code));
  return lines.join('\n');
}

function categorySection(category: ErrorCategory): string {
  const codes = ERROR_CODES.filter((code) => ERROR_REGISTRY[code].category === category);
  if (codes.length === 0) return '';
  const [title, intro] = CATEGORY_TEXT[category];
  return [
    `## ${title}`,
    '',
    intro,
    '',
    table(
      ['Code', 'Title', 'HTTP', 'Retryable'],
      codes.map((code) => {
        const spec = ERROR_REGISTRY[code];
        return [codeAnchorLink(code), spec.title, String(spec.httpStatus), spec.retryable];
      }),
    ),
    '',
    codes.map(codeSection).join('\n\n'),
  ].join('\n');
}

/**
 * Render `docs/reference/errors.md`.
 *
 * @returns The Markdown document.
 */
export function renderErrors(): string {
  return document([
    GENERATED_HEADER,
    '# Error reference',
    `Every error code BrowserHive can produce (${ERROR_CODES.length} codes), generated from \`ERROR_REGISTRY\` in \`@browserhive/contracts/errors\`. Each code has a stable anchor: \`errors.md#<CODE>\`, which is also the \`type\` URL of HTTP problem responses (${inlineCode(errorDocsUrl('<CODE>'))}).`,
    '## How errors reach you',
    [
      '- **MCP tools:** the result has `isError: true` and a text block `[CODE] message` (a stable text format clients may parse). The structured form `{ code, message, retryable, hint?, details? }` is in `_meta["browserhive.ai/error"]`.',
      '- **REST API:** `application/problem+json` (RFC 9457) with `type`, `title`, `status`, `detail`, plus `code`, `retryable`, `hint`, `details` and `request_id`.',
      '- **WebSocket:** a frame with `kind: "error"` and payload `{ code, title, hint?, details?, request_id? }`; the `corr` of the failed command is echoed.',
      '- **CLI:** boot errors print `browserhive: [CODE] message` to stderr and exit with the code listed per entry.',
    ].join('\n'),
    '## Retry guidance',
    table(
      ['`retryable`', 'Meaning'],
      Retryable.options.map((r) => [inlineCode(r), RETRYABLE_TEXT[r]]),
    ),
    ...ErrorCategory.options.map(categorySection),
  ]);
}
