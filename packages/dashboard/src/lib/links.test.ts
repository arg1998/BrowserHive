/** @module lib/links.test — every docs link the dashboard uses resolves to a page and anchor in docs/ */
import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  configKeyDocsUrl,
  DOCS_PAGES,
  type DocsPage,
  docsUrl,
  errorCodeDocsUrl,
  releaseUrl,
  toolDocsUrl,
} from './links.ts';

const DOCS = resolve(import.meta.dir, '../../../../docs');

function fileOf(page: string): string {
  return resolve(DOCS, page === '' ? 'README.md' : `${page}.md`);
}

/** Anchors the website generates for a page: explicit `id="…"` plus GitHub-style heading slugs. */
function anchorsOf(page: string): ReadonlySet<string> {
  const text = readFileSync(fileOf(page), 'utf8');
  const anchors = new Set<string>();
  for (const m of text.matchAll(/\bid="([^"]+)"/g)) if (m[1] !== undefined) anchors.add(m[1]);
  for (const m of text.replace(/```[\s\S]*?```/g, '').matchAll(/^#{2,6}\s+(.+)$/gm)) {
    anchors.add(
      (m[1] ?? '')
        .replace(/`/g, '')
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s_-]/gu, '')
        .replace(/\s/g, '-'),
    );
  }
  return anchors;
}

describe('docs links', () => {
  it('every docs page the dashboard links to exists, with its anchor', () => {
    for (const [key, entry] of Object.entries(DOCS_PAGES) as [
      DocsPage,
      { page: string; anchor?: string },
    ][]) {
      expect(existsSync(fileOf(entry.page)), `${key}: ${entry.page}`).toBe(true);
      if (entry.anchor !== undefined) {
        expect(anchorsOf(entry.page).has(entry.anchor), `${key}: #${entry.anchor}`).toBe(true);
      }
    }
  });

  it('points at the website, not GitHub', () => {
    expect(docsUrl('home')).toBe('https://browserhive.ai/docs/');
    expect(docsUrl('vaultBindings')).toBe('https://browserhive.ai/docs/guide/vault/#bindings');
    expect(configKeyDocsUrl('maxSessions')).toBe(
      'https://browserhive.ai/docs/reference/configuration/#maxSessions',
    );
    expect(errorCodeDocsUrl('SESSION_NOT_FOUND')).toBe(
      'https://browserhive.ai/docs/reference/errors/#SESSION_NOT_FOUND',
    );
    expect(toolDocsUrl('vault_fill')).toBe(
      'https://browserhive.ai/docs/reference/tools/#vault_fill',
    );
    expect(releaseUrl('0.1.2')).toBe(
      'https://github.com/arg1998/BrowserHive/releases/tag/browserhive@0.1.2',
    );
  });

  it('config key and error anchors exist in the references', () => {
    const config = anchorsOf('reference/configuration');
    for (const key of ['maxSessions', 'transport', 'blocklist', 'stealth', 'vault', 'otel']) {
      expect(config.has(key), key).toBe(true);
    }
    expect(anchorsOf('reference/errors').has('SESSION_NOT_FOUND')).toBe(true);
    expect(anchorsOf('reference/tools').has('vault_fill')).toBe(true);
  });
});
