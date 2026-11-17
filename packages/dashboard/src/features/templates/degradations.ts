/** @module features/templates/degradations — template degradations of `/system` (spec 13 §2.4, §3.2) read for operators: which template a `TEMPLATE_*` event names, and a sentence about it without internal terms or ids; the sites turned off on a template below its pack's stealth floor (`TEMPLATE_SITE_BELOW_FLOOR`, D-71) */
import type { SystemEvent } from '@browserhive/contracts/http';
import { z } from 'zod';

/** The template ids a degradation names (`template_id`, or `template_ids` for a missing key). */
export function templatesOf(event: Pick<SystemEvent, 'code' | 'details'>): readonly string[] {
  if (!event.code.startsWith('TEMPLATE_')) return [];
  const details = event.details;
  if (typeof details !== 'object' || details === null) return [];
  const { template_id: one, template_ids: many } = details as {
    readonly template_id?: unknown;
    readonly template_ids?: unknown;
  };
  if (typeof one === 'string') return [one];
  if (Array.isArray(many)) return many.filter((v): v is string => typeof v === 'string');
  return [];
}

const FAILURE: Readonly<Record<string, string>> = {
  no_display: 'there is no screen on this machine',
  proxy_unreachable: 'its proxy did not answer',
  sandbox_unavailable: 'Chromium’s sandbox is unavailable here',
  host_failed: 'it failed several times in a row',
};

/** A sentence about a template degradation (`name`: the template's display name), or `null`. */
export function templateDegradationText(
  event: Pick<SystemEvent, 'code' | 'details'>,
  name: string,
): string | null {
  const details = (event.details ?? {}) as { readonly reason?: unknown };
  switch (event.code) {
    case 'TEMPLATE_HOST_FAILED': {
      const why = typeof details.reason === 'string' ? FAILURE[details.reason] : undefined;
      return `The browser of ${name} could not start${why === undefined ? '' : `: ${why}`}.`;
    }
    case 'TEMPLATE_KEY_MISSING':
      return `${name}: no encryption key, so its versions and checkpoint are not written.`;
    case 'TEMPLATE_KEY_MISMATCH':
      return `${name}: some versions were saved with another key and can’t be restored with the current one.`;
    case 'TEMPLATE_CHECKPOINT_FAILED':
      return `${name}: the last checkpoint could not be written.`;
    case 'TEMPLATE_CHECKPOINT_TOO_LARGE':
      return `${name}: the checkpoint was too large; some site storage was left out.`;
    case 'TEMPLATE_SITE_BELOW_FLOOR': {
      const parsed = FloorOff.safeParse(event.details);
      const sites = parsed.success
        ? [...new Set(parsed.data.templates.flatMap((t) => t.site_ids))].join(', ')
        : 'A site';
      return `${sites} was turned off on ${name}: its site pack now needs stronger stealth settings than the template has.`;
    }
    default:
      return null;
  }
}

/** The unresolved key problem naming `templateId`, if any. */
export function keyProblemOf(
  events: readonly SystemEvent[] | undefined,
  templateId: string,
): SystemEvent | null {
  return (
    (events ?? []).find(
      (e) =>
        e.resolved_at === null &&
        (e.code === 'TEMPLATE_KEY_MISSING' || e.code === 'TEMPLATE_KEY_MISMATCH') &&
        templatesOf(e).includes(templateId),
    ) ?? null
  );
}

/** `TEMPLATE_SITE_BELOW_FLOOR` details, parsed (never cast). */
const FloorOff = z.object({
  pack_id: z.string(),
  version: z.number(),
  reason: z.string(),
  templates: z.array(
    z.object({
      template_id: z.string(),
      site_ids: z.array(z.string()),
      issues: z.array(z.object({ code: z.string(), message: z.string() })),
    }),
  ),
});

/** Sites turned off on one template below their pack's stealth floor (an open record). */
export interface FloorOff {
  readonly eventId: string;
  readonly packId: string;
  readonly version: number;
  /** `local_override_ended`: the approved local file is gone. */
  readonly reason: string;
  readonly siteIds: readonly string[];
  readonly issues: readonly { readonly code: string; readonly message: string }[];
}

/** The open `TEMPLATE_SITE_BELOW_FLOOR` records naming `templateId`, one per pack. */
export function floorOffOf(
  events: readonly SystemEvent[] | undefined,
  templateId: string,
): readonly FloorOff[] {
  const out: FloorOff[] = [];
  for (const e of events ?? []) {
    if (e.resolved_at !== null || e.code !== 'TEMPLATE_SITE_BELOW_FLOOR') continue;
    const parsed = FloorOff.safeParse(e.details);
    const mine = parsed.success
      ? parsed.data.templates.find((t) => t.template_id === templateId)
      : undefined;
    if (!parsed.success || mine === undefined) continue;
    out.push({
      eventId: e.event_id,
      packId: parsed.data.pack_id,
      version: parsed.data.version,
      reason: parsed.data.reason,
      siteIds: mine.site_ids,
      issues: mine.issues,
    });
  }
  return out;
}
