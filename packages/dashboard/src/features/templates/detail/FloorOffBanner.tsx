/** @module features/templates/detail/FloorOffBanner — a site BrowserHive turned off on this template because the version of its site pack now in force needs stronger stealth settings than the template has (`TEMPLATE_SITE_BELOW_FLOOR`, D-71, review #84 M1): which site, why, and the two ways on (stealth is fixed for a template's life) */
import type { SystemEvent } from '@browserhive/contracts/http';
import { Callout } from '@/components/shared/Callout.tsx';
import { fixFor } from '@/features/site-packs/FloorRefusal.tsx';
import { docsUrl } from '@/lib/links.ts';
import { type FloorOff, floorOffOf } from '../degradations.ts';

/** Why the version in force changed, in words. */
function becauseText(reason: string): string {
  return reason === 'local_override_ended'
    ? 'its approved local pack file was removed, so the published version applies again'
    : 'the version of its site pack in force changed';
}

/** One callout per pack whose site was turned off on this template; nothing when none is open. */
export function FloorOffBanner({
  events,
  templateId,
}: {
  readonly events: readonly SystemEvent[] | undefined;
  readonly templateId: string;
}) {
  const off = floorOffOf(events, templateId);
  return (
    <>
      {off.map((o) => (
        <FloorOffCallout key={o.eventId} off={o} />
      ))}
    </>
  );
}

/** One pack's record: the site, why it was turned off, and the ways on. */
function FloorOffCallout({ off }: { readonly off: FloorOff }) {
  const sites = off.siteIds.join(', ');
  const settings = [...new Set(off.issues.map((i) => fixFor(i.code)))].join(' and ');
  return (
    <Callout tone="warn" title={`${sites} was turned off`}>
      <p className="text-pretty">
        BrowserHive turned it off because {becauseText(off.reason)} (v{off.version}), and that
        version {off.issues.map((i) => i.message).join(' and ')}. A template’s stealth settings
        can’t change, so to use {sites} again, create a new template with {settings} and sign in
        there, or remove the site here.{' '}
        <a
          href={docsUrl('sitePacksFloor')}
          target="_blank"
          rel="noreferrer"
          className="text-link underline decoration-link/40 underline-offset-2 hover:decoration-link"
        >
          When a version raises the stealth floor
        </a>
      </p>
    </Callout>
  );
}
