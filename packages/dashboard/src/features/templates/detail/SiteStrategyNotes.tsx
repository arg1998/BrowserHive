/** @module features/templates/detail/SiteStrategyNotes — on a site's card of the Sites tab (spec 13 §9.4, §11.4; D49, D50): what the site's pack asks for that this template or this machine cannot apply in full, one warning each with the server's plain-words explanation (forced humanized input on a template with stealth off; one focused tab on a headless template on macOS or Windows) */
import type { TemplateStrategyNote } from '@browserhive/contracts/http';
import { Callout } from '@/components/shared/Callout.tsx';

/** Each note's title. */
export const STRATEGY_NOTE_TITLE: Readonly<Record<TemplateStrategyNote['code'], string>> = {
  humanize_needs_stealth: 'Humanized input is not applied',
  single_focus_limited: 'One focused tab is limited on this machine',
};

/** The site's strategy notes; nothing when there are none. */
export function SiteStrategyNotes({ notes }: { readonly notes: readonly TemplateStrategyNote[] }) {
  if (notes.length === 0) return null;
  return (
    <div className="flex flex-col gap-3 px-5 pt-4" data-testid="strategy-notes">
      {notes.map((note) => (
        <Callout key={note.code} tone="warn" title={STRATEGY_NOTE_TITLE[note.code]}>
          <span className="text-pretty">{note.message}</span>
        </Callout>
      ))}
    </div>
  );
}
