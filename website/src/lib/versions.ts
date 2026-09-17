/** @module website/lib/versions — docs version lookup from the synced manifest. */
import manifest from '../generated/docs.json';

export type DocsVersion = (typeof manifest.versions)[number];

export const versions: DocsVersion[] = manifest.versions;
export const latest = versions[0] as DocsVersion;

/** The version a docs entry id (`docs/v0/guide/cli`) or pathname (`/docs/v0/guide/cli/`) belongs to. */
export function versionOf(idOrPath: string): DocsVersion {
  const m = /^\/?docs\/(v\d+)(\/|$)/.exec(idOrPath);
  return versions.find((v) => !v.latest && v.label === m?.[1]) ?? latest;
}

/** The same page in another version, or that version's docs home. */
export function switchVersionHref(
  pathname: string,
  target: DocsVersion,
  pageIds: Set<string>,
): string {
  const from = versionOf(pathname);
  const rest = pathname.startsWith(from.base) ? pathname.slice(from.base.length) : '';
  const candidate = `${target.base}${rest}`;
  const id = candidate.replace(/^\//, '').replace(/\/$/, '') || 'docs';
  return pageIds.has(id) ? candidate : target.base;
}
