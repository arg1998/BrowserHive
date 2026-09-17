/** Social preview images: `/og/home.png` and one per docs page, e.g. `/og/docs/guide/vault.png`. */

import { getCollection } from 'astro:content';
import type { APIRoute, GetStaticPaths } from 'astro';
import { HOME_OG_IMAGE, ogImagePath, sectionOf } from '../../lib/og.ts';
import { type OgCard, renderOgImage } from '../../lib/og-image.ts';
import { latest, versionOf } from '../../lib/versions.ts';

/** `/og/docs/guide/vault.png` → `docs/guide/vault`. */
const slugOf = (path: string) => path.slice('/og/'.length, -'.png'.length);

export const getStaticPaths = (async () => {
  const home: OgCard = {
    eyebrow: 'MCP server · local-first · MIT',
    title: 'A browser hive for your agents.',
    highlight: 'agents',
    description:
      'Isolated, stealthy Chromium sessions for any MCP client, with password logins the model never sees, human takeover and a replayable audit trail.',
    badge: `v${latest.version}`,
    url: 'browserhive.ai',
    footnote: '$ bun add -g browserhive',
  };
  const docs = (await getCollection('docs', (e) => e.id.startsWith('docs'))).map((entry) => {
    const version = versionOf(entry.id);
    const card: OgCard = {
      eyebrow: sectionOf(entry.id),
      title: entry.data.title,
      description: entry.data.description,
      badge: `docs · ${version.label}${version.latest ? '' : ` (${version.version})`}`,
      url: `browserhive.ai/${entry.id}/`,
    };
    return { params: { slug: slugOf(ogImagePath(entry.id)) }, props: { card } };
  });
  return [{ params: { slug: slugOf(HOME_OG_IMAGE) }, props: { card: home } }, ...docs];
}) satisfies GetStaticPaths;

export const GET: APIRoute<{ card: OgCard }> = async ({ props }) => {
  const png = await renderOgImage(props.card);
  return new Response(new Uint8Array(png), { headers: { 'Content-Type': 'image/png' } });
};
