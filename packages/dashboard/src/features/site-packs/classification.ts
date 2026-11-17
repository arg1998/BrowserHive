/** @module features/site-packs/classification — the words, tones and icons of a pack change's classification (spec 13 §9.7, §11.4 UI vocabulary: Tightens rules / Can stop the site / Relaxes rules), the ordering that puts what needs a careful look first, and the per-class counts a diff summarises */
import type { SitePackChange, SitePackClassification } from '@browserhive/contracts/http';
import type { IconName } from '@/lib/icons.ts';
import type { Tone } from '@/lib/status-registry.ts';

/** One field's class (`null`: not classified, a new pack's fields). */
export type FieldClass = SitePackChange['class'];

/** How a classification shows: label, tone, icon and one sentence of what it means. */
export interface ClassificationInfo {
  readonly label: string;
  readonly tone: Tone;
  readonly icon: IconName;
  readonly summary: string;
}

/** Every classification, in the UI's words. */
export const CLASSIFICATION_INFO: { readonly [K in SitePackClassification]: ClassificationInfo } = {
  loosening: {
    label: 'Relaxes rules',
    tone: 'danger',
    icon: 'warn',
    summary:
      'Removes or weakens a protection, widens what the pack covers, or changes an address BrowserHive opens. Read every highlighted field before you apply it.',
  },
  restrictive: {
    label: 'Can stop the site',
    tone: 'warn',
    icon: 'danger',
    summary:
      'Adds a limit that can stop agents from using the site: a guard or check on the sign-in or signed-in check page, one session at a time, a short active window, or a stealth floor above a template.',
  },
  tightening: {
    label: 'Tightens rules',
    tone: 'success',
    icon: 'secured',
    summary: 'Adds or strengthens protections and limits; nothing is relaxed.',
  },
  neutral: {
    label: 'No rule change',
    tone: 'neutral',
    icon: 'minus',
    summary: 'Only descriptions, sources or dates change; enforcement stays the same.',
  },
  new_pack: {
    label: 'New pack',
    tone: 'info',
    icon: 'plus',
    summary: 'Nothing was approved for this site before: every rule is new.',
  },
  local_override: {
    label: 'Local override',
    tone: 'accent',
    icon: 'local',
    summary: 'A local file approved in place of the published version.',
  },
  revoked: {
    label: 'Revoked',
    tone: 'danger',
    icon: 'failure',
    summary:
      'The publisher revoked the version in force. This is the version approved before it; it relaxes rules or can stop the site, so it waits for you.',
  },
  unclassified: {
    label: 'Not classified',
    tone: 'muted',
    icon: 'help',
    summary: 'Recorded before BrowserHive classified pack changes.',
  },
};

/** The four field classes, strongest first (spec 13 §9.7). */
export const FIELD_CLASSES = ['loosening', 'restrictive', 'tightening', 'neutral'] as const;

const RANK: Readonly<Record<string, number>> = {
  loosening: 0,
  restrictive: 1,
  tightening: 2,
  neutral: 3,
};

/** Changes ordered so loosening and restrictive fields come first; document order within a class. */
export function bySeverity<T extends { readonly class: FieldClass }>(changes: readonly T[]): T[] {
  return changes
    .map((change, index) => ({ change, index }))
    .sort(
      (a, b) =>
        (RANK[a.change.class ?? ''] ?? 4) - (RANK[b.change.class ?? ''] ?? 4) || a.index - b.index,
    )
    .map((x) => x.change);
}

/** How many fields of each class a diff has, strongest first, zero counts left out. */
export function classCounts(
  changes: readonly { readonly class: FieldClass }[],
): readonly { readonly cls: (typeof FIELD_CLASSES)[number]; readonly count: number }[] {
  return FIELD_CLASSES.map((cls) => ({
    cls,
    count: changes.filter((c) => c.class === cls).length,
  })).filter((c) => c.count > 0);
}

/** "2 relax rules", "1 can stop the site": a per-class count in words. */
export function countText(cls: (typeof FIELD_CLASSES)[number], count: number): string {
  const one = count === 1;
  switch (cls) {
    case 'loosening':
      return `${count} ${one ? 'relaxes' : 'relax'} rules`;
    case 'restrictive':
      return `${count} can stop the site`;
    case 'tightening':
      return `${count} ${one ? 'tightens' : 'tighten'} rules`;
    case 'neutral':
      return `${count} ${one ? 'changes' : 'change'} no rule`;
    default:
      return `${count}`;
  }
}

/** True for the classes an operator should read field by field (highlighted, asked about with care). */
export function needsCare(cls: FieldClass | SitePackClassification | undefined): boolean {
  return cls === 'loosening' || cls === 'restrictive' || cls === 'revoked';
}
