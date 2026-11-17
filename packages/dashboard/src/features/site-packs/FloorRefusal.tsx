/** @module features/site-packs/FloorRefusal — Apply refused with `SITE_PACK_BELOW_FLOOR` (spec 13 §9.4 `stealth-profile`, §10.6; T3b lead decision 4), readable: a dialog naming each template below the version's stealth floor, what it lacks and how to fix it (raise stealth or change fingerprint noise in its Settings, or turn the site off there), and a line on the card that reopens it */
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { z } from 'zod';
import { Callout } from '@/components/shared/Callout.tsx';
import { Button } from '@/components/ui/button.tsx';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.tsx';
import { useTemplatesOverview } from '@/features/templates/api.ts';
import type { AppError } from '@/lib/api/errors.ts';

/** `SITE_PACK_BELOW_FLOOR` details, parsed (never cast). */
const FloorDetails = z.object({
  pack_id: z.string(),
  version: z.number(),
  templates: z.array(
    z.object({
      template_id: z.string(),
      name: z.string(),
      issues: z.array(z.object({ code: z.string(), message: z.string() })),
    }),
  ),
});
/** A refusal's details. */
export type FloorDetails = z.infer<typeof FloorDetails>;

/** The details of a below-floor refusal, or `null` for any other error. */
export function floorRefusalOf(error: AppError | null): FloorDetails | null {
  if (error === null || error.code !== 'SITE_PACK_BELOW_FLOOR') return null;
  const parsed = FloorDetails.safeParse(error.details);
  return parsed.success ? parsed.data : null;
}

/** An issue message as a sentence ("needs …" → "Needs …"). */
function sentence(message: string): string {
  return message.charAt(0).toUpperCase() + message.slice(1);
}

/** What to change in a template's Settings for one issue. */
export function fixFor(code: string): string {
  switch (code) {
    case 'stealth_below_floor':
      return 'Raise Stealth in its Settings';
    case 'fingerprint_required':
      return 'Turn fingerprint noise on in its Settings';
    case 'fingerprint_forbidden':
      return 'Turn fingerprint noise off in its Settings';
    default:
      return 'Change its stealth settings';
  }
}

/** The dialog. */
function FloorDialog({
  refusal,
  title,
  open,
  onOpenChange,
}: {
  readonly refusal: FloorDetails;
  readonly title: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const templates = useTemplatesOverview();
  const nameOf = (id: string, name: string) =>
    templates.data?.data.find((t) => t.template_id === id)?.display_name ?? name;
  const n = refusal.templates.length;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            <bdi>{title}</bdi> v{refusal.version} wasn’t applied
          </DialogTitle>
          <DialogDescription>
            This version raises the site’s stealth floor above{' '}
            {n === 1 ? 'a template' : `${n} templates`} that {n === 1 ? 'uses' : 'use'} it. Nothing
            changed: the current version keeps applying.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3 pb-1">
          <ul aria-label="Templates below the floor" className="flex flex-col gap-2">
            {refusal.templates.map((t) => (
              <li
                key={t.template_id}
                className="flex min-w-0 flex-col gap-1.5 rounded-lg border p-3"
              >
                <Link
                  to="/templates/$id"
                  params={{ id: t.template_id }}
                  search={{ tab: 'settings' }}
                  className="font-medium text-link underline decoration-link/40 underline-offset-2 hover:decoration-link focus-ring rounded-sm"
                >
                  <bdi>{nameOf(t.template_id, t.name)}</bdi>
                </Link>
                <ul className="flex flex-col gap-1 text-sm">
                  {t.issues.map((issue) => (
                    <li key={issue.code} className="flex flex-col">
                      <span className="text-foreground">{sentence(issue.message)}</span>
                      <span className="text-muted-foreground">{fixFor(issue.code)}.</span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
          <p className="text-sm text-muted-foreground text-pretty">
            Change {n === 1 ? 'that template' : 'those templates'}, or turn the site off on{' '}
            {n === 1 ? 'it' : 'them'} (Sites tab), then apply again. Rejecting the version keeps the
            current one.
          </p>
        </DialogBody>
        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  );
}

/** The card's line after a refusal, with the dialog (open at once, reopenable). */
export function FloorRefusal({
  refusal,
  title,
}: {
  readonly refusal: FloorDetails;
  readonly title: string;
}) {
  const [open, setOpen] = useState(true);
  const n = refusal.templates.length;
  return (
    <>
      <Callout
        tone="warn"
        title={`Not applied: ${n === 1 ? 'a template is' : `${n} templates are`} below this version’s stealth floor`}
        action={
          <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
            What to change
          </Button>
        }
      >
        {refusal.templates.map((t) => t.name).join(', ')}
      </Callout>
      <FloorDialog refusal={refusal} title={title} open={open} onOpenChange={setOpen} />
    </>
  );
}
