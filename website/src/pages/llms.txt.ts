/** llms.txt: a Markdown index of the latest docs with links to raw Markdown pages. */

import { getCollection } from 'astro:content';
import type { APIRoute } from 'astro';
import manifest from '../generated/docs.json';
import { markdownHref } from '../lib/docs-urls.ts';
import { latest } from '../lib/versions.ts';

export const GET: APIRoute = async ({ site }) => {
  const origin = (site?.toString() ?? 'https://browserhive.ai/').replace(/\/$/, '');
  const entries = await getCollection('docs');
  const byRoute = new Map(entries.map((e) => [`/${e.id}/`.replace('//', '/'), e]));
  const lines = [
    '# BrowserHive',
    '',
    '> Local-first MCP server that gives AI agents isolated, stealthy Chromium sessions, with vault-backed logins the model never sees, human takeover, a full audit trail and an operator dashboard.',
    '',
    `Documentation for the latest major version (${latest.label}, ${latest.version}). Install with \`bun add -g browserhive\`. Every page is also available as Markdown by replacing the trailing slash with \`.md\`.`,
    '',
  ];
  for (const group of manifest.sidebars[latest.label as keyof typeof manifest.sidebars] ?? []) {
    lines.push(`## ${group.label}`, '');
    for (const item of group.items) {
      const entry = byRoute.get(item.link);
      const href = entry ? `${origin}${markdownHref(entry.id)}` : `${origin}${item.link}`;
      const desc = entry?.data.description ? `: ${entry.data.description}` : '';
      lines.push(`- [${item.label}](${href})${desc}`);
    }
    lines.push('');
  }
  lines.push(
    '## Optional',
    '',
    `- [Full documentation in one file](${origin}/llms-full.txt)`,
    '- [Source code](https://github.com/arg1998/BrowserHive)',
    '- [npm package](https://www.npmjs.com/package/browserhive)',
    '',
  );
  return new Response(lines.join('\n'), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
