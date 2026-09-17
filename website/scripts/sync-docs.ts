/**
 * @module website/scripts/sync-docs — copies repository docs/ into the site's content collection.
 *
 * The repository's docs/ folder is the only source. The current major comes from the working tree;
 * each older major comes from its newest `browserhive@x.y.z` release tag. Everything this writes is
 * gitignored build input. `--watch` re-syncs the current major when docs/ changes.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import {
  type DocsVersion,
  EXCLUDED_DIRS,
  frontmatter,
  pageId,
  REPO_URL,
  resolveVersions,
  rewriteLinks,
  type SidebarGroup,
  sidebarFromReadme,
  splitPage,
} from './docs-source.ts';

const WEBSITE = join(import.meta.dir, '..');
const REPO = join(WEBSITE, '..');
const CONTENT_OUT = join(WEBSITE, 'src/content/docs/docs');
const PUBLIC_OUT = join(WEBSITE, 'public/docs');
const MANIFEST_OUT = join(WEBSITE, 'src/generated/docs.json');
const REDIRECTS_OUT = join(WEBSITE, 'public/_redirects');

export interface DocsManifest {
  versions: DocsVersion[];
  sidebars: Record<string, SidebarGroup[]>;
  /** Page count per version label. */
  pages: Record<string, number>;
}

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** A readable snapshot of docs/ at one ref. */
interface Source {
  files: string[];
  read(path: string): Buffer;
  lastUpdated(path: string): Date | undefined;
}

function workingTreeSource(): Source {
  const root = join(REPO, 'docs');
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      return statSync(p).isDirectory() ? walk(p) : [relative(root, p).split(sep).join('/')];
    });
  return {
    files: walk(root),
    read: (p) => readFileSync(join(root, p)),
    lastUpdated: (p) => {
      try {
        const iso = git(['log', '-1', '--format=%cI', '--', `docs/${p}`]).trim();
        return iso ? new Date(iso) : undefined;
      } catch {
        return undefined;
      }
    },
  };
}

function tagSource(ref: string): Source {
  const files = git(['ls-tree', '-r', '--name-only', ref, 'docs/'])
    .split('\n')
    .filter(Boolean)
    .map((f) => f.slice('docs/'.length));
  const date = new Date(git(['log', '-1', '--format=%cI', ref]).trim());
  return {
    files,
    read: (p) =>
      execFileSync('git', ['show', `${ref}:docs/${p}`], { cwd: REPO, maxBuffer: 64 * 1024 * 1024 }),
    lastUpdated: () => date,
  };
}

/** Writes only when content changed, so the dev server does not reload for nothing. */
function writeIfChanged(path: string, data: string | Buffer, written: Set<string>): void {
  written.add(path);
  if (existsSync(path)) {
    const old = readFileSync(path);
    if (Buffer.compare(old, Buffer.isBuffer(data) ? data : Buffer.from(data)) === 0) return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}

function removeStale(dir: string, written: Set<string>): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      removeStale(p, written);
      if (readdirSync(p).length === 0) rmSync(p, { recursive: true });
    } else if (!written.has(p)) {
      rmSync(p);
    }
  }
}

function syncVersion(
  version: DocsVersion,
  source: Source,
  latest: DocsVersion,
  written: Set<string>,
): { sidebar: SidebarGroup[]; pages: number } {
  const published = new Set(
    source.files.filter((f) => !EXCLUDED_DIRS.some((d) => f.startsWith(d))),
  );
  const prefix = version.latest ? '' : `${version.label}/`;
  let pages = 0;
  for (const file of published) {
    if (!file.endsWith('.md')) {
      writeIfChanged(join(PUBLIC_OUT, prefix, file), source.read(file), written);
      continue;
    }
    const id = pageId(file);
    const fallback = id.split('/').pop() ?? id;
    const page = splitPage(source.read(file).toString('utf8'), fallback);
    const body = rewriteLinks(page.body, { docsPath: file, version, published });
    const data: Record<string, unknown> = {
      title: page.title,
      description: page.description,
      editUrl: version.latest && !page.generated ? `${REPO_URL}/edit/main/docs/${file}` : false,
      lastUpdated: source.lastUpdated(file),
      sourcePath: `docs/${file}`,
      docsVersion: version.label,
    };
    if (!version.latest) {
      data['banner'] = {
        content: `You are reading the docs for BrowserHive ${version.version} (${version.label}). <a href="${latest.base}">Go to the latest version (${latest.label})</a>.`,
      };
    }
    writeIfChanged(join(CONTENT_OUT, prefix, `${id}.md`), frontmatter(data) + body, written);
    pages++;
  }
  const readme = published.has('README.md') ? source.read('README.md').toString('utf8') : '';
  return { sidebar: sidebarFromReadme(readme, { version, published }), pages };
}

/**
 * Cloudflare `_redirects`. Short URLs printed by the CLI and used as problem+json `type` identifiers
 * (`/docs/errors#CODE`, `/docs/configuration`) land on the references; browsers keep the `#anchor`.
 * Versioned links to the latest major keep working: `/docs/v1/x` → `/docs/x` while v1 is latest.
 */
export function redirects(latestLabel: string): string {
  return [
    '/docs/errors  /docs/reference/errors/  301',
    '/docs/errors/  /docs/reference/errors/  301',
    '/docs/configuration  /docs/reference/configuration/  301',
    '/docs/configuration/  /docs/reference/configuration/  301',
    `/docs/${latestLabel}  /docs/  302`,
    `/docs/${latestLabel}/*  /docs/:splat  302`,
    '',
  ].join('\n');
}

export function syncDocs(): DocsManifest {
  const pkg = JSON.parse(readFileSync(join(REPO, 'packages/browserhive/package.json'), 'utf8'));
  let tags: string[] = [];
  try {
    tags = git(['tag', '--list', 'browserhive@*']).split('\n').filter(Boolean);
  } catch {
    // Not a git checkout: the working tree is the only version.
  }
  const versions = resolveVersions(String(pkg.version), tags);
  const latest = versions[0] as DocsVersion;
  const written = new Set<string>();
  const manifest: DocsManifest = { versions, sidebars: {}, pages: {} };
  for (const version of versions) {
    const source = version.latest ? workingTreeSource() : tagSource(version.ref);
    const { sidebar, pages } = syncVersion(version, source, latest, written);
    manifest.sidebars[version.label] = sidebar;
    manifest.pages[version.label] = pages;
  }
  removeStale(CONTENT_OUT, written);
  removeStale(PUBLIC_OUT, written);
  writeIfChanged(MANIFEST_OUT, `${JSON.stringify(manifest, null, 2)}\n`, written);
  writeIfChanged(REDIRECTS_OUT, redirects(latest.label), written);
  return manifest;
}

if (import.meta.main) {
  const report = (m: DocsManifest) =>
    console.log(
      `sync-docs: ${m.versions.map((v) => `${v.label} (${v.ref}, ${m.pages[v.label]} pages)`).join(', ')}`,
    );
  report(syncDocs());
  if (process.argv.includes('--watch')) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    watch(join(REPO, 'docs'), { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          report(syncDocs());
        } catch (err) {
          console.error('sync-docs failed:', err);
        }
      }, 150);
    });
    console.log('sync-docs: watching docs/');
  }
}
