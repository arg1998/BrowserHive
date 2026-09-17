/**
 * @module website/route-middleware — scopes the sidebar and prev/next links to the docs version of
 * the current page, and adds the social preview image tags.
 */
import { defineRouteMiddleware, type StarlightRouteData } from '@astrojs/starlight/route-data';
import manifest from './generated/docs.json';
import { ogImagePath, socialImageTags } from './lib/og.ts';
import { versionOf } from './lib/versions.ts';

type Entry = StarlightRouteData['sidebar'][number];
type Link = Extract<Entry, { type: 'link' }>;

function firstHref(entry: Entry): string | undefined {
  if (entry.type === 'link') return entry.href;
  for (const child of entry.entries) {
    const href = firstHref(child);
    if (href) return href;
  }
  return undefined;
}

function flatten(entries: Entry[]): Link[] {
  return entries.flatMap((e) => (e.type === 'link' ? [e] : flatten(e.entries)));
}

export const onRequest = defineRouteMiddleware((context) => {
  const route = context.locals.starlightRoute;
  const current = versionOf(route.id);
  const others = manifest.versions.filter((v) => v.label !== current.label);
  const belongs = (href: string) =>
    href.startsWith(current.base) &&
    !others.some((o) => o.base.length > current.base.length && href.startsWith(o.base));

  route.sidebar = route.sidebar.filter((entry) => {
    const href = firstHref(entry);
    return href !== undefined && belongs(href);
  });

  const image = new URL(ogImagePath(route.entry.id), context.site).href;
  route.head.push(...socialImageTags(image, `${route.entry.data.title} · BrowserHive docs`), {
    tag: 'meta',
    attrs: { name: 'twitter:title', content: route.entry.data.title },
  });
  if (route.entry.data.description) {
    route.head.push({
      tag: 'meta',
      attrs: { name: 'twitter:description', content: route.entry.data.description },
    });
  }
  if (route.lastUpdated) {
    route.head.push({
      tag: 'meta',
      attrs: { property: 'article:modified_time', content: route.lastUpdated.toISOString() },
    });
  }

  const links = flatten(route.sidebar);
  const at = links.findIndex((l) => l.isCurrent);
  if (at !== -1) {
    route.pagination = { prev: links[at - 1], next: links[at + 1] };
  }
});
