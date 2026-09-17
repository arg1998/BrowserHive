/** @module website/lib/og — social preview (Open Graph / Twitter) metadata shared by the landing page, docs and image endpoint. */
import manifest from '../generated/docs.json';
import { isVersionRoot } from './docs-urls.ts';
import { versionOf } from './versions.ts';

export const SITE_NAME = 'BrowserHive';
export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;
export const HOME_OG_IMAGE = '/og/home.png';

/** Image path for a docs entry: `docs/guide/vault` → `/og/docs/guide/vault.png`, `docs` → `/og/docs/index.png`. */
export function ogImagePath(entryId: string): string {
  if (!entryId.startsWith('docs')) return HOME_OG_IMAGE;
  return `/og/${isVersionRoot(entryId) ? `${entryId}/index` : entryId}.png`;
}

/** The sidebar group a docs page is listed under, e.g. `Guides`. */
export function sectionOf(entryId: string): string {
  if (isVersionRoot(entryId)) return 'Documentation';
  const version = versionOf(entryId);
  const route = `/${entryId}/`;
  const groups = manifest.sidebars[version.label as keyof typeof manifest.sidebars] ?? [];
  return groups.find((g) => g.items.some((i) => i.link === route))?.label ?? 'Documentation';
}

export interface HeadTag {
  tag: 'meta';
  attrs: Record<string, string>;
}

/** Tags that make a link unfurl with a large image on X, LinkedIn, Slack, Discord and others. */
export function socialImageTags(imageUrl: string, alt: string): HeadTag[] {
  const meta = (key: 'property' | 'name', k: string, content: string): HeadTag => ({
    tag: 'meta',
    attrs: { [key]: k, content },
  });
  return [
    meta('property', 'og:image', imageUrl),
    meta('property', 'og:image:secure_url', imageUrl),
    meta('property', 'og:image:type', 'image/png'),
    meta('property', 'og:image:width', String(OG_WIDTH)),
    meta('property', 'og:image:height', String(OG_HEIGHT)),
    meta('property', 'og:image:alt', alt),
    meta('name', 'twitter:image', imageUrl),
    meta('name', 'twitter:image:alt', alt),
  ];
}
