/** @module features/templates/wizard/FinishDialog — Finish (spec 13 §7.1): warns when a site is not signed in (agents would get signed-out pages there; **Keep signing in** is then the primary action), lists the **unlisted sign-ins** of the window ("Also signed in to: google.com — agents can use this") with Remove sign-in preselected, then finishes */
import type { TemplateSiteView } from '@browserhive/contracts/http';
import { useEffect, useRef, useState } from 'react';
import { Callout } from '@/components/shared/Callout.tsx';
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
  const offered = useRef<ReadonlySet<string>>(new Set(unlisted));
  // A domain that appears while the dialog is open is added checked; the operator's choices stay.
  useEffect(() => {
    if (!open) {
      offered.current = new Set();
      return;
    }
    const fresh = unlisted.filter((d) => !offered.current.has(d));
    if (fresh.length === 0) return;
    offered.current = new Set([...offered.current, ...fresh]);
    setRemove((prev) => new Set([...prev, ...fresh]));
  }, [open, unlisted]);
  const notSignedIn = sites.filter((s) => s.health.state !== 'signed_in');
  const warn = notSignedIn.length > 0;
  const names = notSignedIn.map((s) => s.site_id).join(', ');
  const chosen = unlisted.filter((d) => remove.has(d));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {warn ? 'Finish without every site signed in?' : 'Finish signing in?'}
          </DialogTitle>
          <DialogDescription>
            The window closes and agents can launch sessions from this template.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-5">
          {warn ? (
            <Callout
              tone="warn"
              title={
                notSignedIn.length === sites.length
                  ? 'No site is signed in'
                  : `${notSignedIn.length} of ${sites.length} sites aren’t signed in`
              }
            >
              Agents will get signed-out pages on {names}. Sign in there and press I’m signed in, or
              finish now and sign in again later from the template’s page.
            </Callout>
          ) : (
            <p className="text-sm text-muted-foreground">Every site is signed in.</p>
          )}
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
        </DialogBody>
        <DialogFooter>
          <Button
            type="button"
            variant={warn ? 'default' : 'outline'}
            onClick={() => onOpenChange(false)}
          >
            Keep signing in
          </Button>
          <Button
            type="button"
            variant={warn ? 'outline' : 'default'}
            disabled={finishing}
            onClick={() => onFinish(chosen)}
          >
            {finishing ? <Spinner /> : null}
            {warn ? 'Finish anyway' : 'Finish'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
