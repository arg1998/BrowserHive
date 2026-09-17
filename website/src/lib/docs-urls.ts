/** @module website/lib/docs-urls — URL helpers shared by docs components and endpoints. */

/** `docs` and `docs/v0` are version roots; their pages live at `…/index`. */
export function isVersionRoot(entryId: string): boolean {
  return entryId === 'docs' || /^docs\/v\d+$/.test(entryId);
}

/** Path segment of the raw Markdown endpoint for an entry: `guide/cli` or `index` or `v0/index`. */
export function markdownSlug(entryId: string): string {
  const rest = entryId.replace(/^docs\/?/, '');
  return isVersionRoot(entryId) ? (rest ? `${rest}/index` : 'index') : rest;
}

/** `/docs/guide/cli.md` for `docs/guide/cli`. */
export function markdownHref(entryId: string): string {
  return `/docs/${markdownSlug(entryId)}.md`;
}

/** Reading time in minutes at 230 words per minute, ignoring fenced code. */
export function readingMinutes(markdown: string | undefined): number {
  if (!markdown) return 1;
  const prose = markdown.replace(/```[\s\S]*?```/g, ' ');
  const words = prose.split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 230));
}
