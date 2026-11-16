/** @module features/templates/wizard/SignInStart — before the window is open: what happens (a window on the machine running BrowserHive, a tab per site, nobody sees what you type) and the button that opens it */
import { Button } from '@/components/ui/button.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { ICONS } from '@/lib/icons.ts';
import { docsUrl } from '@/lib/links.ts';

/** Open-the-window panel. `remote`: the machine's name when it is not this device. */
export function SignInStart({
  remote,
  opening,
  ready,
  onOpen,
}: {
  readonly remote: string | null;
  readonly opening: boolean;
  /** `false` until the step knows whether a window is already open. */
  readonly ready: boolean;
  readonly onOpen: () => void;
}) {
  const Window = ICONS.toolTab;
  return (
    <div className="flex flex-col items-start gap-4 rounded-lg border border-dashed border-border-strong p-5">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent-bg text-accent-text">
          <Window aria-hidden="true" className="size-4.5" />
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-base font-medium">Sign in by hand, once</p>
          <p className="max-w-2xl text-sm text-pretty text-muted-foreground">
            A browser window opens{' '}
            {remote !== null ? `on ${remote}` : 'on the machine running BrowserHive'} with a tab for
            each site. Agents never see what you type. Google and a few other sites refuse automated
            browsers;{' '}
            <a
              href={docsUrl('templatesGoogle')}
              target="_blank"
              rel="noreferrer"
              className="text-link underline decoration-link/40 underline-offset-2 hover:decoration-link"
            >
              see what to do
            </a>
            .
          </p>
        </div>
      </div>
      <Button type="button" disabled={opening || !ready} onClick={onOpen}>
        {opening ? <Spinner /> : <Window aria-hidden="true" />}
        {remote !== null ? `Open browser on ${remote}` : 'Open the sign-in window'}
      </Button>
    </div>
  );
}
