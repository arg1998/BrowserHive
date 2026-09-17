/** Raw Markdown for every docs page, for agents and "copy as Markdown": `/docs/guide/cli.md`. */

import { type CollectionEntry, getCollection } from 'astro:content';
import type { APIRoute, GetStaticPaths } from 'astro';
import { markdownSlug } from '../../lib/docs-urls.ts';

export const getStaticPaths = (async () => {
  const entries = await getCollection('docs', (e) => e.id.startsWith('docs'));
  return entries.map((entry) => ({ params: { slug: markdownSlug(entry.id) }, props: { entry } }));
}) satisfies GetStaticPaths;

export const GET: APIRoute<{ entry: CollectionEntry<'docs'> }> = ({ props }) => {
  const { title } = props.entry.data;
  return new Response(`# ${title}\n\n${props.entry.body ?? ''}`, {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  });
};
