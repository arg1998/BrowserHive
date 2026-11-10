/** @module contracts/test/tools/template-wording.test — the agent-facing wording rule of spec 13 §5 (owner decision 2026-11-08): every agent-visible string only template sessions produce says what the session can and cannot do, never how templates work or that other sessions exist. */

import { describe, expect, it } from 'bun:test';
import { ERROR_CODES, ERROR_REGISTRY, type ErrorCode } from '../../src/errors/index.ts';
import {
  LIST_TEMPLATES_DESCRIPTION,
  TEMPLATE_BUSY_LIMIT_TEXT,
  TEMPLATE_CLIPBOARD_TEXT,
  TEMPLATE_PARAM_DESCRIPTION,
  TEMPLATE_VAULT_NOTE,
  TEMPLATES_SERVER_INSTRUCTION,
  templateFixesOptionText,
} from '../../src/tools/index.ts';

/** Words that would reveal the mechanism or other sessions (spec 13 §5). */
const BANNED = [
  /\bbrowsers?\b/i,
  /\bwindows?\b/i,
  /\bhosts?\b/i,
  /\bshared\b/i,
  /\bother sessions?\b/i,
  /\bsiblings?\b/i,
  /\bagents\b/i,
  /\bin use\b/i,
];

/**
 * Template and site codes an agent never receives: REST-only, boot (degradation) and warning codes
 * are operator surfaces. Every other `TEMPLATE_*`, `SITE_*` and `SESSION_SEALED` code is
 * agent-facing and checked below, so a new agent-facing code cannot skip the rule.
 */
const OPERATOR_ONLY: ReadonlySet<string> = new Set([
  'TEMPLATE_NAME_TAKEN',
  'TEMPLATE_IN_USE',
  'TEMPLATE_VERSION_NOT_FOUND',
  'TEMPLATE_VERSION_UNREADABLE',
  'SITE_PACK_NOT_FOUND',
  'SITE_PACK_INVALID',
  'SITE_PACK_UPDATE_NOT_PENDING',
]);

function agentFacingCodes(): ErrorCode[] {
  return ERROR_CODES.filter((code) => {
    const spec = ERROR_REGISTRY[code];
    const templateOnly =
      code.startsWith('TEMPLATE_') || code.startsWith('SITE_') || code === 'SESSION_SEALED';
    return templateOnly && spec.category === 'domain' && !OPERATOR_ONLY.has(code);
  });
}

function offences(text: string): string[] {
  return BANNED.filter((re) => re.test(text)).map((re) => re.source);
}

describe('template wording (spec 13 §5)', () => {
  it('covers the T1a agent-facing codes', () => {
    expect(agentFacingCodes()).toEqual(
      expect.arrayContaining([
        'TEMPLATE_NOT_FOUND',
        'TEMPLATE_BUSY',
        'TEMPLATE_UNAVAILABLE',
        'TEMPLATE_DISABLED',
        'SESSION_SEALED',
      ]),
    );
  });

  it('error titles, messages, hints and detail values say nothing about the mechanism', () => {
    for (const code of agentFacingCodes()) {
      const spec = ERROR_REGISTRY[code];
      for (const text of [spec.title, spec.message, spec.hint ?? '']) {
        expect({ code, text, offences: offences(text) }).toEqual({ code, text, offences: [] });
      }
    }
    for (const value of ['starting', 'restarting', 'recovering', 'disabled', 'needs_operator']) {
      expect(offences(value)).toEqual([]);
    }
  });

  it('descriptions, instructions, notes and refusal texts follow the rule', () => {
    const texts = [
      LIST_TEMPLATES_DESCRIPTION,
      TEMPLATE_PARAM_DESCRIPTION,
      TEMPLATES_SERVER_INSTRUCTION,
      TEMPLATE_VAULT_NOTE,
      TEMPLATE_CLIPBOARD_TEXT,
      TEMPLATE_BUSY_LIMIT_TEXT.capacity('job-hunt'),
      TEMPLATE_BUSY_LIMIT_TEXT.tabs(),
      TEMPLATE_BUSY_LIMIT_TEXT.pace('linkedin.com'),
      templateFixesOptionText('job-hunt', 'context_options.locale'),
    ];
    for (const text of texts)
      expect({ text, offences: offences(text) }).toEqual({ text, offences: [] });
  });

  it('the guard itself catches each banned word', () => {
    for (const sample of [
      'the shared browser',
      'another window',
      'the host restarted',
      'other sessions of this template',
      'a sibling signed out',
      'all agents',
      'the template is in use',
    ]) {
      expect(offences(sample).length).toBeGreaterThan(0);
    }
  });
});
