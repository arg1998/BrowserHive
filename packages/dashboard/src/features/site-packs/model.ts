/** @module features/site-packs/model — pure words and helpers of the site-pack pages (spec 13 §9.3, §9.6, §10.5, §11.4 UI vocabulary): provenance lines, short SHA-256, local-file states, the terms' stance, write policies, skip reasons, diff values as text, the pack that owns a domain, and what adding a site would approve */
import type {
  SitePackProvenance,
  SitePackSkipReason,
  SitePackSourceKind,
  SitePacksResponse,
  SitePackView,
} from '@browserhive/contracts/http';
import type { Tone } from '@/lib/status-registry.ts';

/** A pack's terms stance (`write_policy.stance`). */
export type Stance = SitePackView['stance'];
/** A write policy. */
export type WritePolicy = SitePackView['write_policy_default'];

/**
 * A pack-derived string isolated for plain-text surfaces (toasts, dialog copy): wrapped in Unicode
 * FIRST STRONG ISOLATE / POP DIRECTIONAL ISOLATE, so bidi controls inside it cannot reorder the text
 * around it (review S-H4; markup uses `<bdi>`). `refinePack` refuses such controls too.
 */
export function iso(text: string): string {
  return `\u2068${text}\u2069`;
}

/** What the UI says when a pack has no `write` guards (review S-H3): its write policy has nothing to act on. */
export const NO_WRITE_GUARDS =
  'This pack guards no writes yet, so its write policy has no effect: agents post and send without asking.';

/** The first 12 hex digits, enough to tell versions apart at a glance. */
export function shortSha(sha256: string): string {
  return sha256.slice(0, 12);
}

/** A source in one word. */
export const SOURCE_LABEL: { readonly [K in SitePackSourceKind]: string } = {
  bundled: 'Bundled',
  remote: 'Online',
  import: 'Imported',
  local: 'Local file',
};

/** Where a version came from, as the approval was shown (spec 13 §11.4). */
export function provenanceText(
  provenance: SitePackProvenance | null,
  source: SitePackSourceKind,
): string {
  if (provenance === null) return SOURCE_LABEL[source];
  switch (provenance.kind) {
    case 'bundled':
      return `Bundled with BrowserHive ${provenance.release}`;
    case 'remote':
      return `browserhive.ai registry · key ${provenance.key_id} · signature verified · index ${provenance.index_version}`;
    case 'import':
      return `Imported file ${provenance.file}`;
    case 'local':
      return `Local file ${provenance.path}`;
  }
}

/** A long file path cut to its last two segments (`…/local/linkedin.com.json`); the full path goes in a tooltip. */
export function shortPath(path: string): string {
  const parts = path.split('/').filter((p) => p !== '');
  return parts.length <= 3 ? path : `…/${parts.slice(-2).join('/')}`;
}

/** `provenanceText` with a local file's path shortened (tables and cards). */
export function shortProvenance(
  provenance: SitePackProvenance | null,
  source: SitePackSourceKind,
): string {
  return provenance?.kind === 'local'
    ? `Local file ${shortPath(provenance.path)}`
    : provenanceText(provenance, source);
}

/** A local file's state (spec 13 §10.5) with its tone. */
export const LOCAL_STATE: {
  readonly [K in NonNullable<SitePackView['local']>['state']]: {
    readonly label: string;
    readonly tone: Tone;
  };
} = {
  approved: { label: 'Approved', tone: 'success' },
  changed: { label: 'Changed since approval — review', tone: 'warn' },
  not_approved: { label: 'Not yet approved', tone: 'warn' },
};

/** "What the site's terms say" as a label (spec 13 §9.3: the stance is shown as a label). */
export const STANCE_TEXT: { readonly [K in Stance]: string } = {
  prohibited: 'The site’s terms prohibit automated access',
  restricted: 'The site’s terms restrict automated access',
  writes_restricted: 'The site’s terms restrict automated posting and changes',
  allowed: 'The site’s terms allow automated access',
};

/** The stance's tone. */
export const STANCE_TONE: { readonly [K in Stance]: Tone } = {
  prohibited: 'danger',
  restricted: 'warn',
  writes_restricted: 'warn',
  allowed: 'success',
};

/** A write policy in one word. */
export const WRITE_POLICY_LABEL: { readonly [K in WritePolicy]: string } = {
  allow: 'Allow',
  warn: 'Warn',
  confirm: 'Confirm',
};

/** What a write policy does to the account's writes. */
export const WRITE_POLICY_HINT: { readonly [K in WritePolicy]: string } = {
  allow: 'Posts, messages and other writes go through.',
  warn: 'Writes go through and are flagged in the session.',
  confirm: 'Each write waits until you approve it on Attention.',
};

/** Why a pack version was skipped. */
export const SKIP_REASON_TEXT: { readonly [K in SitePackSkipReason]: string } = {
  invalid: 'The file isn’t a valid site pack',
  too_large: 'The file is larger than 64 KiB',
  unknown_strategy: 'It uses a strategy this BrowserHive doesn’t know',
  min_client: 'It needs a newer BrowserHive',
  domain_overlap: 'Another pack already owns one of its domains',
  not_found: 'BrowserHive’s copy of the approved version is missing',
  id_mismatch: 'The file name doesn’t match the pack id inside',
  signed_layout_unsupported: 'Signed folders aren’t supported here',
  unreadable: 'The file couldn’t be read',
  layout_refused: 'The signed folder didn’t verify',
};

/**
 * Why a version was skipped, in words; a domain overlap names the pack that owns the domain (the
 * server's detail, review S-M1).
 */
export function skippedText(skipped: NonNullable<SitePackView['skipped']>): string {
  const which = skipped.version === null ? 'A version' : `v${skipped.version}`;
  const why = SKIP_REASON_TEXT[skipped.reason];
  return skipped.reason === 'domain_overlap' && skipped.detail !== ''
    ? `${which} was skipped: ${why} (${skipped.detail}).`
    : `${which} was skipped: ${why}.`;
}

/** A follow setting in words. */
export const FOLLOW_LABEL: { readonly [K in SitePackView['follow']['setting']]: string } = {
  auto: 'Auto',
  on: 'On',
  off: 'Off',
};

/** A diff value as text (JSON, never markup); absent values read "(none)". */
export function valueText(value: unknown): string {
  if (value === undefined || value === null) return '(none)';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/** The host of a URL shown as plain text beside it (spec 13 §9.3: the domain is shown), or `null`. */
export function domainOf(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

/** The pack whose domains contain `host` (or a parent of it), else `null`. */
export function packForHost(packs: readonly SitePackView[], host: string): SitePackView | null {
  const h = host.toLowerCase().replace(/\.$/, '');
  return packs.find((p) => p.domains.some((d) => h === d || h.endsWith(`.${d}`))) ?? null;
}

/** What adding a site with this pack approves (or keeps): the approved version, else the offer. */
export interface PackChoice {
  readonly version: number;
  readonly sha256: string;
  readonly source: SitePackSourceKind;
  readonly provenance: string;
  /** The provenance with a local path shortened (cards). */
  readonly provenanceShort: string;
  /** `true`: another template already approved it; adding the site keeps that version. */
  readonly approved: boolean;
}

/** The version a new site would use, or `null` when nothing is on offer (a local file not yet approved). */
export function packChoice(view: SitePackView): PackChoice | null {
  if (view.approved !== null) {
    return {
      version: view.approved.version,
      sha256: view.approved.sha256,
      source: view.approved.source,
      provenance: provenanceText(view.approved.provenance, view.approved.source),
      provenanceShort: shortProvenance(view.approved.provenance, view.approved.source),
      approved: true,
    };
  }
  if (view.offer !== null) {
    return {
      version: view.offer.version,
      sha256: view.offer.sha256,
      source: view.offer.source,
      provenance: provenanceText(view.offer.provenance, view.offer.source),
      provenanceShort: shortProvenance(view.offer.provenance, view.offer.source),
      approved: false,
    };
  }
  return null;
}

/** The sentence shown before a site is added with a pack (spec 13 §9.6 "First use"). */
export function approvalSentence(view: SitePackView, choice: PackChoice): string {
  const what = `${iso(view.title)} v${choice.version} (${iso(choice.provenance)}, SHA-256 ${shortSha(choice.sha256)}…)`;
  return choice.approved
    ? `Uses ${what}, already approved for another template.`
    : `Adding this site approves ${what}.`;
}

/** The nav badge: pending versions of followed packs plus local files needing approval. */
export function packsNeedingReview(
  response: Pick<SitePacksResponse, 'pending_count' | 'local_needing_approval'> | undefined,
): number {
  return response === undefined ? 0 : response.pending_count + response.local_needing_approval;
}

/** `true` when the pack has something for the operator to decide (an update or a local file). */
export function needsReview(view: SitePackView): boolean {
  return (
    (view.follow.effective && view.pinned_version === null && view.pending.length > 0) ||
    (view.local !== null && view.local.state !== 'approved' && view.local.problem === null)
  );
}

/** The pack and the sentence to show for a host, when a pack with a version on offer owns it. */
export function packNote(
  packs: readonly SitePackView[],
  host: string | null,
): { readonly pack: SitePackView; readonly sha256: string; readonly text: string } | null {
  if (host === null) return null;
  const pack = packForHost(packs, host);
  const choice = pack === null ? null : packChoice(pack);
  if (pack === null || choice === null) return null;
  return { pack, sha256: choice.sha256, text: approvalSentence(pack, choice) };
}
