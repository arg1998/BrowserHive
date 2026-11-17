/** @module features/site-packs/FloorRefusal — Apply, Approve or Revert refused with `SITE_PACK_BELOW_FLOOR` (spec 13 §9.4 `stealth-profile`, §10.6; D-71), readable: a dialog naming each template below the version's stealth floor and what it lacks, with the fixes BrowserHive allows (stealth and fingerprint noise are fixed for a template's life, review #84 M3): turn the site off on that template's Sites tab, or create a new template with the settings the pack needs; or reject the version. A card keeps a line that reopens it. The dialog has one close affordance (review #84 L5) */
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { z } from 'zod';
import { Callout } from '@/components/shared/Callout.tsx';
import { Button } from '@/components/ui/button.tsx';
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.tsx';
import { useTemplatesOverview } from '@/features/templates/api.ts';
import type { AppError } from '@/lib/api/errors.ts';
import { docsUrl } from '@/lib/links.ts';

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

/** The action that was refused. */
export type FloorAction = 'apply' | 'approve' | 'revert';

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

/** The setting a new template needs for one issue ("higher stealth"). */
export function fixFor(code: string): string {
  switch (code) {
    case 'stealth_below_floor':
      return 'higher stealth';
    case 'fingerprint_required':
      return 'fingerprint noise on';
    case 'fingerprint_forbidden':
      return 'fingerprint noise off';
    default:
      return 'the stealth settings the pack needs';
  }
}

/** What a template can do: its stealth settings are fixed, so turn the site off, or start anew. */
export function templateFix(issues: readonly { readonly code: string }[]): string {
  const settings = [...new Set(issues.map((i) => fixFor(i.code)))];
  return `Turn the site off on this template, or create a new template with ${settings.join(' and ')}.`;
}

const TITLE: { readonly [K in FloorAction]: (title: string, version: number) => string } = {
  apply: (title, version) => `${title} v${version} wasn’t applied`,
  approve: (title) => `The local ${title} file wasn’t approved`,
  revert: (title, version) => `${title} wasn’t reverted to v${version}`,
};

const OTHERWISE: { readonly [K in FloorAction]: string } = {
  apply: 'Or reject the version: the current one keeps applying.',
  approve: 'Or leave the file unapproved: the content in force keeps applying.',
  revert: 'Or keep the current version.',
};

/** The dialog (also opened alone by Revert, which has no card). */
export function FloorDialog({
  refusal,
  title,
  action,
  open,
  onOpenChange,
}: {
  readonly refusal: FloorDetails;
  readonly title: string;
  readonly action: FloorAction;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const templates = useTemplatesOverview();
  const nameOf = (id: string, name: string) =>
    templates.data?.data.find((t) => t.template_id === id)?.display_name ?? name;
  const n = refusal.templates.length;
  const subject = action === 'approve' ? 'This file' : `v${refusal.version}`;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            <bdi>{TITLE[action](title, refusal.version)}</bdi>
          </DialogTitle>
          <DialogDescription>
            {subject} needs stronger stealth settings than{' '}
            {n === 1 ? 'a template that uses' : `${n} templates that use`} the site, and a
            template’s stealth and fingerprint noise can’t change after it is created. Nothing
            changed: the current version keeps applying.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3 pb-1">
          <ul aria-label="Templates below the floor" className="flex flex-col gap-2">
            {refusal.templates.map((t) => {
              const name = nameOf(t.template_id, t.name);
              return (
                <li
                  key={t.template_id}
                  className="flex min-w-0 flex-col gap-1.5 rounded-lg border p-3"
                >
                  <p className="font-medium text-foreground [overflow-wrap:anywhere]">
                    <bdi>{name}</bdi>
                  </p>
                  <ul className="flex flex-col gap-0.5 text-sm text-foreground">
                    {t.issues.map((issue) => (
                      <li key={issue.code}>{sentence(issue.message)}.</li>
                    ))}
                  </ul>
                  <p className="text-sm text-muted-foreground text-pretty">
                    {templateFix(t.issues)}
                  </p>
                  <Link
                    to="/templates/$id"
                    params={{ id: t.template_id }}
                    search={{ tab: 'sites' }}
                    className="self-start rounded-sm text-sm text-link underline decoration-link/40 underline-offset-2 hover:decoration-link focus-ring"
                  >
                    Open the Sites tab of <bdi>{name}</bdi>
                  </Link>
                </li>
              );
            })}
          </ul>
          <p className="text-sm text-muted-foreground text-pretty">
            {OTHERWISE[action]}{' '}
            <a
              href={docsUrl('sitePacksFloor')}
              target="_blank"
              rel="noreferrer"
              className="text-link underline decoration-link/40 underline-offset-2 hover:decoration-link"
            >
              When a version raises the stealth floor
            </a>
          </p>
        </DialogBody>
        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" />}>Close</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const CALLOUT: { readonly [K in Exclude<FloorAction, 'revert'>]: string } = {
  apply: 'Not applied',
  approve: 'Not approved',
};

/** The card's line after a refusal, with the dialog (open at once, reopenable). */
export function FloorRefusal({
  refusal,
  title,
  action,
}: {
  readonly refusal: FloorDetails;
  readonly title: string;
  readonly action: Exclude<FloorAction, 'revert'>;
}) {
  const [open, setOpen] = useState(true);
  const n = refusal.templates.length;
  return (
    <>
      <Callout
        tone="warn"
        title={`${CALLOUT[action]}: ${n === 1 ? 'a template is' : `${n} templates are`} below this version’s stealth floor`}
        action={
          <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
            What to change
          </Button>
        }
      >
        {refusal.templates.map((t) => t.name).join(', ')}
      </Callout>
      <FloorDialog
        refusal={refusal}
        title={title}
        action={action}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}
