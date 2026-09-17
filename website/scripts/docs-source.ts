/** @module website/scripts/docs-source — pure helpers that turn repository docs/ into site pages: versions, titles, links, sidebar. */
import { posix } from 'node:path';

export const REPO_URL = 'https://github.com/arg1998/BrowserHive';

/** One published major version of the docs. */
export interface DocsVersion {
  major: number;
  /** `v0`, `v1`, … */
  label: string;
  /** The newest major; served unprefixed at /docs/. */
  latest: boolean;
  /** Route prefix with trailing slash: `/docs/` or `/docs/v0/`. */
  base: string;
  /** Git ref the pages come from: a release tag, or `main` for the working tree. */
  ref: string;
  /** Full version string of that ref (from the tag or package.json). */
  version: string;
}

export interface SidebarLink {
  label: string;
  link: string;
}
export interface SidebarGroup {
  label: string;
  items: SidebarLink[];
}

/** README sections that stay on GitHub. */
const EXCLUDED_SECTIONS = new Set(['contributing']);
/** docs/ subfolders that stay on GitHub. */
export const EXCLUDED_DIRS = ['contributing/'];

interface Semver {
  major: number;
  minor: number;
  patch: number;
  raw: string;
}

function parseTag(tag: string): Semver | undefined {
  const m = /^browserhive@(\d+)\.(\d+)\.(\d+)$/.exec(tag.trim());
  if (!m) return undefined;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    raw: `${m[1]}.${m[2]}.${m[3]}`,
  };
}

/**
 * Picks one docs version per major: the working tree for the current major, and the newest
 * stable release tag for every older major.
 */
export function resolveVersions(currentVersion: string, tags: string[]): DocsVersion[] {
  const current = Number(currentVersion.split('.')[0]);
  const newest = new Map<number, Semver>();
  for (const tag of tags) {
    const v = parseTag(tag);
    if (!v || v.major >= current) continue;
    const prev = newest.get(v.major);
    if (!prev || v.minor > prev.minor || (v.minor === prev.minor && v.patch > prev.patch)) {
      newest.set(v.major, v);
    }
  }
  const archived = [...newest.values()]
    .sort((a, b) => b.major - a.major)
    .map<DocsVersion>((v) => ({
      major: v.major,
      label: `v${v.major}`,
      latest: false,
      base: `/docs/v${v.major}/`,
      ref: `browserhive@${v.raw}`,
      version: v.raw,
    }));
  return [
    {
      major: current,
      label: `v${current}`,
      latest: true,
      base: '/docs/',
      ref: 'main',
      version: currentVersion,
    },
    ...archived,
  ];
}

/** `guide/quick-start.md` → `guide/quick-start`; `README.md` → `index`; `guide/README.md` → `guide/index`. */
export function pageId(docsPath: string): string {
  const noExt = docsPath.replace(/\.md$/, '');
  return noExt === 'README' ? 'index' : noExt.replace(/\/README$/, '/index');
}

/** Route of a page id under a version base, with trailing slash. */
export function pageRoute(base: string, id: string): string {
  if (id === 'index') return base;
  return `${base}${id.replace(/\/index$/, '')}/`;
}

export interface SplitPage {
  title: string;
  description: string | undefined;
  body: string;
  generated: boolean;
}

/** Splits a page into its H1 title, a plain-text description from the first paragraph, and the rest. */
export function splitPage(markdown: string, fallbackTitle: string): SplitPage {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const generated = /^<!--\s*generated\b/i.test(lines[0] ?? '');
  let i = 0;
  while (
    i < lines.length &&
    (lines[i]?.trim() === '' || /^<!--.*-->$/.test(lines[i]?.trim() ?? ''))
  )
    i++;
  let title = fallbackTitle;
  const h1 = /^#\s+(.+?)\s*#*$/.exec(lines[i] ?? '');
  if (h1?.[1]) {
    title = h1[1];
    i++;
  }
  const body = lines.slice(i).join('\n').replace(/^\n+/, '');
  return { title, description: describe(body), body, generated };
}

function describe(body: string): string | undefined {
  const para = body.split(/\n\s*\n/).find((p) => {
    const t = p.trim();
    return t && !/^(#|```|\||[-*+]\s|\d+\.\s|<|>|!\[)/.test(t);
  });
  if (!para) return undefined;
  const text = para
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return undefined;
  return text.length <= 180 ? text : `${text.slice(0, 177).replace(/\s+\S*$/, '')}…`;
}

export interface LinkContext {
  /** Path of the page inside docs/, e.g. `guide/quick-start.md`. */
  docsPath: string;
  version: DocsVersion;
  /** Every file path inside docs/ that the site publishes. */
  published: Set<string>;
}

/** Rewrites one relative Markdown link target into a site route or a GitHub URL. */
export function rewriteTarget(target: string, ctx: LinkContext): string {
  if (/^([a-z][a-z0-9+.-]*:|#|\/)/i.test(target)) return target;
  const hashAt = target.indexOf('#');
  const path = hashAt === -1 ? target : target.slice(0, hashAt);
  const hash = hashAt === -1 ? '' : target.slice(hashAt);
  const resolved = posix.normalize(posix.join(posix.dirname(ctx.docsPath), path));
  if (resolved.startsWith('../')) {
    const repoPath = posix.normalize(posix.join('docs', resolved));
    const ref = ctx.version.ref;
    return `${REPO_URL}/blob/${ref}/${repoPath}${hash}`;
  }
  if (!ctx.published.has(resolved)) {
    return `${REPO_URL}/blob/${ctx.version.ref}/docs/${resolved}${hash}`;
  }
  if (resolved.endsWith('.md')) return pageRoute(ctx.version.base, pageId(resolved)) + hash;
  return `${ctx.version.base}${resolved}${hash}`;
}

/** Rewrites inline Markdown link targets outside fenced code blocks. */
export function rewriteLinks(markdown: string, ctx: LinkContext): string {
  let fence: string | undefined;
  return markdown
    .split('\n')
    .map((line) => {
      const f = /^\s*(```+|~~~+)/.exec(line);
      if (f?.[1]) {
        if (!fence) fence = f[1];
        else if (line.trim().startsWith(fence)) fence = undefined;
        return line;
      }
      if (fence) return line;
      return line.replace(/(\]\()([^)\s]+)((?:\s+"[^"]*")?\))/g, (_m, open, target, close) => {
        return `${open}${rewriteTarget(target, ctx)}${close}`;
      });
    })
    .join('\n');
}

/**
 * Builds the sidebar from the docs index README: every `##` section becomes a group and every
 * list item link to a Markdown page becomes an entry, in README order.
 */
export function sidebarFromReadme(
  readme: string,
  ctx: Omit<LinkContext, 'docsPath'>,
): SidebarGroup[] {
  const groups: SidebarGroup[] = [];
  let current: SidebarGroup | undefined;
  let skip = false;
  for (const line of readme.split('\n')) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h?.[1]) {
      skip = EXCLUDED_SECTIONS.has(h[1].toLowerCase());
      current = skip ? undefined : { label: h[1], items: [] };
      if (current) groups.push(current);
      continue;
    }
    if (skip || !current) continue;
    const item = /^\s*[-*]\s+\[([^\]]+)\]\(([^)\s]+)\)/.exec(line);
    const [, label, target] = item ?? [];
    if (!label || !target?.endsWith('.md')) continue;
    const link = rewriteTarget(target, { ...ctx, docsPath: 'README.md' });
    if (link.startsWith('http')) continue;
    current.items.push({ label, link });
  }
  return groups.filter((g) => g.items.length > 0);
}

/** YAML frontmatter from a flat record; values are JSON-encoded (valid YAML), dates stay YAML timestamps. */
export function frontmatter(data: Record<string, unknown>): string {
  const lines = Object.entries(data)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${v instanceof Date ? v.toISOString() : JSON.stringify(v)}`);
  return `---\n${lines.join('\n')}\n---\n\n`;
}
