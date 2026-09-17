/** llms-full.txt: every latest docs page as Markdown, in sidebar order. */

import { getCollection } from 'astro:content';
import type { APIRoute } from 'astro';
import manifest from '../generated/docs.json';
import { latest } from '../lib/versions.ts';

export const GET: APIRoute = async () => {
  const entries = await getCollection('docs');
  const byRoute = new Map(entries.map((e) => [`/${e.id}/`, e]));
  const parts: string[] = [];
  for (const group of manifest.sidebars[latest.label as keyof typeof manifest.sidebars] ?? []) {
    for (const item of group.items) {
      const entry = byRoute.get(item.link);
      if (entry)
        parts.push(
          `# ${entry.data.title}\n\nSource: https://browserhive.ai${item.link}\n\n${entry.body ?? ''}`,
        );
    }
  }
  return new Response(parts.join('\n\n---\n\n'), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
