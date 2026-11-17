/** @module features/templates/ReloginDialog — Re-login… (spec 13 §8.4, §3.11): pick the site (when the template has several) and how — a window on the BrowserHive machine (agents wait while it is open unless you let them continue), or the live view when the browser has no window to show (agents wait only while you type; the dialog then links to it) or a fill from the linked vault binding — with the remote-operator notice naming that machine */
import type { TemplateSiteView } from '@browserhive/contracts/http';
import { useEffect, useId, useState } from 'react';
import { useToast } from '@/app/providers/ToastProvider.tsx';
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
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group.tsx';
import { toAppError } from '@/lib/api/errors.ts';
import { reloginRefusal, useTemplateHealth } from './api-health.ts';
import { LIVE_VIEW_TEXT, LiveViewLink, liveViewSession } from './LiveViewSignIn.tsx';
import { ReloginSitePicker } from './ReloginSitePicker.tsx';
import { RemoteOperatorBanner } from './RemoteOperatorBanner.tsx';

/** Props. `site` = `null` closes the dialog; `''` opens it without a choice (several sites). */
export interface ReloginDialogProps {
  readonly templateId: string;
  readonly sites: readonly TemplateSiteView[];
  readonly machineName: string;
  readonly site: string | null;
  readonly onClose: () => void;
  /**
   * The browser can't show a window here (a headless template already running): the sign-in goes
   * through the live view. The server decides (no display is known only to it); the answer of the
   * start says so too.
   */
  readonly liveView?: boolean;
}

type Method = 'window' | 'vault';

/** Re-login dialog. */
export function ReloginDialog({
  templateId,
  sites,
  machineName,
  site,
  onClose,
  liveView = false,
}: ReloginDialogProps) {
  const health = useTemplateHealth(templateId);
  const toast = useToast();
  const [chosen, setChosen] = useState('');
  const [method, setMethod] = useState<Method>('window');
  const [letContinue, setLetContinue] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The maintenance session to sign in through, once a start answered `sign_in_via: 'live_view'`.
  const [liveSession, setLiveSession] = useState<string | null>(null);
  const continueId = useId();
  useEffect(() => {
    if (site === null) return;
    setChosen(site !== '' ? site : ((sites.length === 1 ? sites[0]?.site_id : undefined) ?? ''));
    setMethod('window');
    setLetContinue(false);
    setError(null);
    setLiveSession(null);
  }, [site, sites]);
  const current = sites.find((s) => s.site_id === chosen);
  const vault = current?.vault_handle ?? null;
  const effective: Method = vault === null ? 'window' : method;
  const start = () => {
    if (current === undefined) return;
    setError(null);
    health.start.mutate(
      { site: current.site_id, method: effective, letAgentsContinue: letContinue },
      {
        onSuccess: (result) => {
          const live = liveViewSession(result.relogin);
          if (live !== null) {
            setLiveSession(live);
            return;
          }
          toast.success({
            title:
              effective === 'window'
                ? `Sign-in window opened for ${current.title}`
                : `Filling ${current.title} from the vault`,
            ...(effective === 'window' && {
              description: `Sign in on ${machineName}. Progress shows on the Sites tab.`,
            }),
          });
          onClose();
        },
        onError: (e) => setError(reloginRefusal(toAppError(e))),
      },
    );
  };
  const title = site !== '' && current !== undefined ? `Re-login to ${current.title}` : 'Re-login';
  return (
    <Dialog open={site !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Sign in again so agents get signed-in pages. Your sign-ins to the template’s other sites
            stay as they are.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4 pb-1">
          {sites.length > 1 && site === '' ? (
            <ReloginSitePicker sites={sites} value={chosen} onChange={setChosen} />
          ) : null}
          {vault !== null ? (
            <div className="flex flex-col gap-1.5">
              <span id={`${continueId}-how`} className="text-sm font-medium">
                How
              </span>
              <ToggleGroup
                aria-labelledby={`${continueId}-how`}
                size="sm"
                spacing={0}
                value={[effective]}
                onValueChange={(value: readonly string[]) => {
                  const next = value[0];
                  if (next === 'window' || next === 'vault') setMethod(next);
                }}
              >
                <ToggleGroupItem value="window">In a window</ToggleGroupItem>
                <ToggleGroupItem value="vault">With the vault</ToggleGroupItem>
              </ToggleGroup>
            </div>
          ) : null}
          {effective === 'window' ? (
            <>
              {liveView || liveSession !== null ? (
                <p className="text-base text-pretty">
                  {LIVE_VIEW_TEXT} The sign-in ends by itself after 30 minutes.
                </p>
              ) : (
                <>
                  <p className="text-base text-pretty">
                    A window opens at the site on{' '}
                    <strong className="font-medium">{machineName}</strong>, the machine running
                    BrowserHive. Sign in there; BrowserHive notices when you are signed in, or press{' '}
                    <span className="font-medium">I’m signed in</span> on the Sites tab. The window
                    closes by itself after 30 minutes.
                  </p>
                  <RemoteOperatorBanner machineName={machineName} />
                </>
              )}
              {liveSession !== null ? null : (
                <div className="flex items-start gap-3 rounded-lg bg-surface-inset px-3 py-2.5">
                  <Checkbox
                    id={continueId}
                    checked={letContinue}
                    onCheckedChange={(checked: boolean) => setLetContinue(checked)}
                    className="mt-0.5"
                  />
                  <label htmlFor={continueId} className="flex cursor-pointer flex-col gap-0.5">
                    <span className="text-base font-medium">
                      Let agents continue while I sign in
                    </span>
                    <span className="text-sm text-pretty text-muted-foreground">
                      {liveView
                        ? 'Off: this template’s agents wait (launches and tool calls) while you type in the live view. On: they keep working and may change cookies while you sign in.'
                        : 'Off: this template’s agents wait (launches and tool calls) until the window closes. On: they keep working and may change cookies while you sign in.'}
                    </span>
                  </label>
                </div>
              )}
            </>
          ) : (
            <p className="text-base text-pretty">
              BrowserHive opens the sign-in page in the background and fills it with the vault
              binding <span className="font-mono text-sm">{vault}</span>. Nothing opens on screen,
              and the secret never reaches this dashboard.
            </p>
          )}
          {error !== null ? (
            <Callout tone="danger" title="The re-login didn’t start">
              {error}
            </Callout>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {liveSession !== null ? 'Close' : 'Cancel'}
          </Button>
          {liveSession !== null ? (
            <LiveViewLink sessionId={liveSession} />
          ) : (
            <Button
              type="button"
              disabled={current === undefined || health.start.isPending}
              onClick={start}
            >
              {health.start.isPending ? <Spinner /> : null}
              {effective === 'vault'
                ? 'Fill from the vault'
                : liveView
                  ? 'Start sign-in'
                  : 'Open sign-in window'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
