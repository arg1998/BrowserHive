/** @module features/templates/wizard/FinishDialog — Finish (spec 13 §7.1): lists the sites not signed in (kept, marked signed out) and the **unlisted sign-ins** of the window ("Also signed in to: google.com — agents can use this"), each with Remove sign-in preselected, then finishes */
import type { TemplateSiteView } from '@browserhive/contracts/http';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { Checkbox } from '@/components/ui/checkbox.tsx';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';

/** Dialog. */
export function FinishDialog({
  open,
  onOpenChange,
  sites,
  unlisted,
  finishing,
  onFinish,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly sites: readonly TemplateSiteView[];
  readonly unlisted: readonly string[];
  readonly finishing: boolean;
  readonly onFinish: (removeSignIns: readonly string[]) => void;
}) {
  const [remove, setRemove] = useState<ReadonlySet<string>>(new Set(unlisted));
  useEffect(() => {
    if (open) setRemove(new Set(unlisted));
  }, [open, unlisted]);
  const notSignedIn = sites.filter((s) => s.health.state !== 'signed_in');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Finish signing in?</DialogTitle>
          <DialogDescription>
            The window closes and agents can launch sessions from this template.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-5">
          {notSignedIn.length > 0 ? (
            <section className="flex flex-col gap-1.5">
              <h3 className="text-base font-medium">Not signed in</h3>
              <p className="text-sm text-muted-foreground">
                {notSignedIn.map((s) => s.site_id).join(', ')}{' '}
                {notSignedIn.length === 1 ? 'stays' : 'stay'} in the template, marked signed out.
                Sign in later from the template’s page.
              </p>
            </section>
          ) : null}
          {unlisted.length > 0 ? (
            <section className="flex flex-col gap-2">
              <h3 className="text-base font-medium">Also signed in to</h3>
              <p className="text-sm text-muted-foreground">
                The browser holds sign-ins to sites that aren’t in this template. Agents can use
                them. Remove the ones they shouldn’t have.
              </p>
              <ul className="flex flex-col divide-y rounded-lg border">
                {unlisted.map((domain) => (
                  <li key={domain} className="flex items-center gap-3 px-3 py-2.5">
                    <Checkbox
                      id={`unlisted-${domain}`}
                      checked={remove.has(domain)}
                      onCheckedChange={(on) =>
                        setRemove((prev) => {
                          const next = new Set(prev);
                          if (on) next.add(domain);
                          else next.delete(domain);
                          return next;
                        })
                      }
                    />
                    <label
                      htmlFor={`unlisted-${domain}`}
                      className="flex min-w-0 flex-1 cursor-pointer items-center justify-between gap-3"
                    >
                      <span className="truncate font-mono text-base">{domain}</span>
                      <span className="shrink-0 text-sm text-muted-foreground">
                        {remove.has(domain) ? 'Remove sign-in' : 'Keep'}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {notSignedIn.length === 0 && unlisted.length === 0 ? (
            <p className="text-sm text-muted-foreground">Every site is signed in.</p>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Keep signing in
          </Button>
          <Button type="button" disabled={finishing} onClick={() => onFinish([...remove])}>
            {finishing ? <Spinner /> : null}
            Finish
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
