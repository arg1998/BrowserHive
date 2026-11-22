/** @module features/site-packs/registry-model — pure words of the registry client on the Site packs pages (spec 13 §10.4–§10.6, §11.4; D-55): the last check's outcome, why no check runs, why Check now, Download & review and Download all are unavailable, a pack's sources and what the signed index lists for it, an import's result and a check's or Download all's toast */
import type {
  SitePackCheckResponse,
  SitePackDownloadAllResponse,
  SitePackImportResponse,
  SitePackPending,
  SitePackRegistryStatus,
  SitePackSourceKind,
  SitePackView,
} from '@browserhive/contracts/http';
import type { Tone } from '@/lib/status-registry.ts';
import { SOURCE_LABEL } from './model.ts';

/** Who an auto-update is recorded as (`approved.by`, `decided_by`). */
export const AUTO_UPDATER = 'browserhive';

/** The header's check line: when the last check ran and what it found. */
export interface CheckLine {
  /** When the last check ran, `null` when none did. */
  readonly at: number | null;
  /** What it found, in a few words ("up to date", "2 updates", "failed"). */
  readonly outcome: string;
  readonly tone: Tone;
}

/** Why no automatic check runs, one sentence (spec 13 §10.4, §10.5). */
export const CHECK_OFF_TEXT: {
  readonly [K in NonNullable<SitePackRegistryStatus['check_off']>]: string;
} = {
  packs_off: 'Site packs are turned off, so BrowserHive makes no request to the registry.',
  update_check_off:
    'The update check is off, so BrowserHive makes no request to the registry. Import packs by hand.',
  no_trust_root:
    'This build trusts no registry yet: the update check stays off until registry keys are pinned in a release.',
};

/** The header's check line, or `null` with site packs off. */
export function checkLine(status: SitePackRegistryStatus, pendingCount: number): CheckLine | null {
  if (!status.enabled) return null;
  const at = status.last_check_at;
  if (status.check_off === 'no_trust_root')
    return { at: null, outcome: 'No registry trusted yet', tone: 'muted' };
  if (status.check_off !== null) return { at: null, outcome: 'Update check off', tone: 'muted' };
  if (at === null) return { at: null, outcome: 'Not checked yet', tone: 'muted' };
  if (status.stale) return { at, outcome: 'index out of date', tone: 'warn' };
  if (status.last_outcome === 'failed') return { at, outcome: 'failed', tone: 'danger' };
  if (status.last_outcome === 'disabled') return { at, outcome: 'update check off', tone: 'muted' };
  return pendingCount > 0
    ? {
        at,
        outcome: `${pendingCount} ${pendingCount === 1 ? 'update' : 'updates'}`,
        tone: 'accent',
      }
    : { at, outcome: 'up to date', tone: 'success' };
}

/** Why **Check now** is unavailable, or `null`. */
export function checkNowBlocked(status: SitePackRegistryStatus): string | null {
  return status.check_off === null ? null : CHECK_OFF_TEXT[status.check_off];
}

/**
 * Why a download (Download & review, Download all) is unavailable, or `null`: it needs the update
 * check on and a fresh verified index (`SITE_PACKS_REGISTRY_UNAVAILABLE` otherwise).
 */
export function downloadBlocked(status: SitePackRegistryStatus | undefined): string | null {
  if (status === undefined) return null;
  if (status.check_off !== null) return CHECK_OFF_TEXT[status.check_off];
  if (status.index_version === null)
    return 'No signed index has verified yet: press Check now first.';
  if (status.stale)
    return 'The registry index is out of date, so nothing new is downloaded from it: check again first.';
  return null;
}

/** A client range as words: `0.4.0` and `>=0.4.0` read "≥ 0.4.0". */
export function clientRangeText(range: string): string {
  const r = range.trim();
  if (/^\d/.test(r)) return `≥ ${r}`;
  return r.replace(/>=\s*/g, '≥ ').replace(/<=\s*/g, '≤ ').replace(/\s+/g, ' ');
}

/** The newest listed version this binary may use that is newer than the one in force, or `null`. */
export function newerOnline(view: SitePackView): number | null {
  const usable = view.online?.usable_version ?? null;
  if (usable === null) return null;
  return usable > (view.approved?.version ?? 0) ? usable : null;
}

/** The newest version waiting or listed beyond the one in force ("pinned at v7, v9 available"). */
export function newestAvailable(view: SitePackView): number | null {
  const pending = view.pending.reduce<number | null>(
    (max, p) => (max === null || p.version > max ? p.version : max),
    null,
  );
  const online = newerOnline(view);
  if (pending === null) return online;
  if (online === null) return pending;
  return Math.max(pending, online);
}

/** "v9 needs BrowserHive ≥ 0.4.0" when the newest listed version is for another BrowserHive. */
export function needsClientText(view: SitePackView): string | null {
  const online = view.online;
  if (online === null || online.needs_client === null) return null;
  if (online.version <= (view.approved?.version ?? 0)) return null;
  return `v${online.version} needs BrowserHive ${clientRangeText(online.needs_client)}`;
}

/** Sources in a stable order (Bundled, Online, Imported, Local file). */
const SOURCE_ORDER: readonly SitePackSourceKind[] = ['bundled', 'remote', 'import', 'local'];

/** Every source that knows the pack, in words ("Bundled · Online"). */
export function sourcesText(view: SitePackView): string {
  return SOURCE_ORDER.filter((s) => view.sources.includes(s))
    .map((s) => SOURCE_LABEL[s])
    .join(' · ');
}

/** The sources besides the one shown ("Also online", "Also bundled · local file"); `''` when none. */
export function otherSources(view: SitePackView, shown: SitePackSourceKind | null): string {
  const others = SOURCE_ORDER.filter(
    (s) => view.sources.includes(s) && s !== shown && !(s === 'local' && view.local !== null),
  );
  if (others.length === 0) return '';
  return `Also ${others.map((s) => ALSO_LABEL[s]).join(' · ')}`;
}

const ALSO_LABEL: { readonly [K in SitePackSourceKind]: string } = {
  bundled: 'bundled',
  remote: 'online',
  import: 'imported',
  local: 'a local file',
};

/** The pack's version in force was applied by auto-update (`approved.by === 'browserhive'`). */
export function autoUpdated(view: SitePackView): boolean {
  return view.approved?.by === AUTO_UPDATER;
}

/** A pending version that waits for **Download & review** (listed in the index, not fetched yet). */
export function isAvailable(pending: SitePackPending): boolean {
  return pending.state === 'available';
}

/** What Download & review reveals, for the card (spec 13 §10.4 "What the registry learns"). */
export const DOWNLOAD_REVEALS =
  'Downloading fetches this one file from the registry, so the registry learns that your address downloaded this pack version. Download all fetches every version you lack instead.';

/** What Download all hides (the header's info). */
export const DOWNLOAD_ALL_INFO =
  'Download all fetches every listed version you don’t have yet, for every pack, so the registry can’t tell which pack you care about. Nothing applies until you review it.';

/** What an update check sends (D-55). */
export const CHECK_SENDS =
  'Only the signed index: keys.json, index.json and their signatures. No cookie, query, version or install identifier; the registry sees your IP address and when you check, the same two files for every install.';

/** A toast for a Check now answer. */
export function checkToast(response: SitePackCheckResponse): {
  readonly kind: 'success' | 'info' | 'error';
  readonly title: string;
  readonly description?: string;
} {
  const n = response.available;
  const found = n === 0 ? 'nothing newer' : `${n} newer ${n === 1 ? 'version' : 'versions'} listed`;
  const index = response.status.index_version;
  switch (response.outcome) {
    case 'updated':
      return {
        kind: 'success',
        title: index === null ? 'Index verified' : `Index ${index} verified`,
        description: `Signature checked: ${found}.`,
      };
    case 'not_modified':
      return {
        kind: 'success',
        title: 'Up to date',
        description:
          index === null
            ? `The registry has ${found}.`
            : `Index ${index} is still current: ${found}.`,
      };
    case 'disabled':
      return {
        kind: 'info',
        title: 'Update check off',
        description:
          response.status.check_off === null
            ? 'No request was made.'
            : CHECK_OFF_TEXT[response.status.check_off],
      };
    case 'failed':
      return {
        kind: 'error',
        title: 'The update check failed',
        description:
          response.error === undefined
            ? 'Approved packs keep applying.'
            : `${response.error.message} Approved packs keep applying.`,
      };
  }
}

/** A toast for a Download all answer. */
export function downloadAllToast(response: SitePackDownloadAllResponse): {
  readonly kind: 'success' | 'warning';
  readonly title: string;
  readonly description: string;
} {
  const n = response.downloaded.length;
  const refused = response.refused.length;
  const title =
    n === 0 ? 'Nothing new to download' : `Downloaded ${n} ${n === 1 ? 'version' : 'versions'}`;
  const parts = [
    response.held > 0 ? `${response.held} already held` : null,
    refused > 0
      ? `${refused} refused (${response.refused
          .slice(0, 3)
          .map((r) => `${r.pack_id} v${r.version}: ${r.detail || r.reason}`)
          .join('; ')}${refused > 3 ? '; …' : ''})`
      : null,
    response.pending_count > 0
      ? `${response.pending_count} waiting for your review under Updates available`
      : 'nothing waits for review',
  ].filter((p) => p !== null);
  return {
    kind: refused > 0 ? 'warning' : 'success',
    title,
    description: `${parts.join(' · ')}.`,
  };
}

/** What one imported version became, in words. */
export const IMPORT_STATE_TEXT: Readonly<Record<string, string>> = {
  approved: 'approved',
  changed: 'changed since approval: waits for review',
  not_approved: 'waits for approval',
  downloaded: 'waits for review',
  available: 'listed; its file wasn’t in the folder',
  current: 'already in force or not newer',
  refused: 'refused: its file didn’t verify',
  other_client: 'for another BrowserHive',
};

/** The tone of an imported version's state. */
export function importStateTone(state: string): Tone {
  if (state === 'refused') return 'danger';
  if (state === 'downloaded' || state === 'not_approved' || state === 'changed') return 'accent';
  return 'muted';
}

/** The name of a signed layout picked as loose files (no folder). */
export const LOOSE_FILES = 'selected files';

/** The headline of a signed folder's import. */
export function importLayoutTitle(response: SitePackImportResponse, name: string): string {
  const layout = response.layout;
  const what = name === LOOSE_FILES ? 'The signed files' : `Signed folder ${name}`;
  if (layout === undefined) return `${what} imported`;
  return layout.outcome === 'updated'
    ? `${what} verified: index ${layout.index_version}`
    : `${what}: index ${layout.index_version} is the one BrowserHive already holds`;
}

/** Counts of an import by state ("2 wait for review · 1 refused"). */
export function importCounts(response: SitePackImportResponse): string {
  const count = (state: string) => response.imported.filter((i) => i.state === state).length;
  const parts = [
    [count('downloaded'), (n: number) => `${n} ${n === 1 ? 'waits' : 'wait'} for review`],
    [
      count('available'),
      (n: number) => `${n} listed without ${n === 1 ? 'its file' : 'their files'}`,
    ],
    [count('current'), (n: number) => `${n} already current`],
    [count('other_client'), (n: number) => `${n} for another BrowserHive`],
    [count('refused'), (n: number) => `${n} refused`],
  ] as const;
  const text = parts.filter(([n]) => n > 0).map(([n, f]) => f(n));
  return text.length === 0 ? 'No pack version in it is newer.' : `${text.join(' · ')}.`;
}
