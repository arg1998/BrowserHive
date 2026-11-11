/** @module features/templates/degradations — template degradations of `/system` (spec 13 §2.4, §3.2) read for operators: which template a `TEMPLATE_*` event names, and a sentence about it without internal terms or ids */
import type { SystemEvent } from '@browserhive/contracts/http';

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
