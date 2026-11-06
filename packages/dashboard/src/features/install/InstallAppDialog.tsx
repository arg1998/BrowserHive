/** @module features/install/InstallAppDialog — "Install BrowserHive": what to do in this browser when it offers no install prompt (04 §18.8.2–§18.8.4): its own steps, how to reach a secure address, or plainly that it can't install apps and what to use instead */
import type { ReactNode } from 'react';
import { CopyButton } from '@/components/shared/CopyButton.tsx';
import { Button, buttonVariants } from '@/components/ui/button.tsx';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.tsx';
import { effectivePort } from '@/lib/daemon-help/commands.ts';
import { ICONS } from '@/lib/icons.ts';
import { INSTALL_STEPS, type InstallSteps, type StepSegment } from '@/lib/install/steps.ts';
import type { ChromiumBrand, InstallKind } from '@/lib/install/support.ts';
import { docsUrl } from '@/lib/links.ts';
import { cn } from '@/lib/utils.ts';

/** The kinds that open this dialog (`standalone` hides the item; `prompt` opens the browser's own). */
export type DialogKind = Exclude<InstallKind, 'standalone' | 'prompt'>;

/** Where the page is served from (`window.location` satisfies it). */
export interface DialogLocation {
  readonly protocol: string;
  readonly port: string;
  readonly origin: string;
}

/** Props. */
export interface InstallAppDialogProps {
  /** `null` = closed. */
  readonly kind: DialogKind | null;
  readonly brand: ChromiumBrand | null;
  readonly location: DialogLocation;
  readonly onClose: () => void;
}

const UI = 'font-medium text-foreground';

function stepsText(steps: readonly StepSegment[]): ReactNode[] {
  return steps.map((part, i) =>
    typeof part === 'string' ? (
      part
    ) : (
      // biome-ignore lint/suspicious/noArrayIndexKey: fixed copy; segments never reorder
      <span key={i} className={UI}>
        {part.ui}
      </span>
    ),
  );
}

/** The browser's steps in a card, under its name. */
function Steps({ entry }: { readonly entry: InstallSteps }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 rounded-xl border bg-muted/40 px-4 py-3 dark:bg-white/[0.03]">
      {entry.browser !== null ? <span className="eyebrow">{entry.browser}</span> : null}
      <p className="text-base text-pretty text-muted-foreground">{stepsText(entry.steps)}</p>
    </div>
  );
}

/** An address to open elsewhere, with an always-visible copy button. */
function Address({ value, label }: { readonly value: string; readonly label: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-lg border bg-muted/50 py-1 pr-1 pl-3 dark:bg-black/20">
      <code className="min-w-0 flex-1 font-mono text-sm [overflow-wrap:anywhere] select-all">
        {value}
      </code>
      <CopyButton value={value} label={label} size="icon-sm" visibility="always" />
    </div>
  );
}

const CHROMIUM_STEPS: { readonly [B in ChromiumBrand]: InstallSteps } = {
  chrome: INSTALL_STEPS.chrome,
  edge: INSTALL_STEPS.edge,
  other: INSTALL_STEPS['chromium-other'],
};

/** The description line and the body for one kind. */
function content(
  kind: DialogKind,
  brand: ChromiumBrand | null,
  location: DialogLocation,
): { readonly description: ReactNode; readonly body: ReactNode } {
  const thisAddress = <Address value={location.origin} label="Copy this address" />;
  switch (kind) {
    case 'insecure': {
      const loopback = `http://127.0.0.1:${effectivePort(location)}`;
      return {
        description: 'Browsers install apps only from a secure address.',
        body: (
          <>
            <p className="text-pretty text-muted-foreground">
              On the computer running BrowserHive, open this address (if it listens on another
              address,{' '}
              <code className="font-mono text-sm text-foreground">browserhive config show</code>{' '}
              names it):
            </p>
            <Address value={loopback} label="Copy the local address" />
            <p className="text-pretty text-muted-foreground">
              From other devices, give BrowserHive an{' '}
              <code className="font-mono text-sm text-foreground">https</code> address.{' '}
              <a
                href={docsUrl('publicAddress')}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-foreground underline underline-offset-3 hover:text-accent-text"
              >
                How to set a public address
              </a>
            </p>
          </>
        ),
      };
    }
    case 'ios':
      return {
        description: 'Add it to your Home Screen from Safari’s Share menu.',
        body: (
          <p className="text-pretty text-muted-foreground">
            Tap <span className={UI}>Share</span>, then{' '}
            <span className={UI}>Add to Home Screen</span>.
          </p>
        ),
      };
    case 'chromium-android':
      return {
        description: 'Add it to your Home screen from the browser menu.',
        body: (
          <p className="text-pretty text-muted-foreground">
            Open the browser menu <span className={UI}>⋮</span> and choose{' '}
            <span className={UI}>Add to Home screen</span> or{' '}
            <span className={UI}>Install app</span>.
          </p>
        ),
      };
    case 'chromium':
      return {
        description: 'It opens in its own window, from your app launcher or taskbar.',
        body: (
          <>
            <Steps entry={CHROMIUM_STEPS[brand ?? 'other']} />
            <p className="text-sm text-pretty text-muted-foreground">
              Already installed? Your browser shows an <span className={UI}>Open in app</span>{' '}
              button in the address bar instead.
            </p>
          </>
        ),
      };
    case 'firefox-windows':
      return {
        description: 'Firefox adds it to your taskbar as its own app.',
        body: <Steps entry={INSTALL_STEPS['firefox-windows']} />,
      };
    case 'firefox-linux':
      return {
        description: "Firefox on Linux doesn't install websites as apps unless that is turned on.",
        body: (
          <>
            <p className="text-pretty text-muted-foreground">
              Open this address in Chrome, Edge or another Chromium browser to install BrowserHive,
              or bookmark it here.
            </p>
            {thisAddress}
          </>
        ),
      };
    case 'firefox-unsupported':
      return {
        description: "Firefox can't install websites as apps on this system.",
        body: (
          <>
            <p className="text-pretty text-muted-foreground">
              Open this address in Chrome, Edge or another Chromium browser to install BrowserHive,
              or bookmark it here.
            </p>
            {thisAddress}
          </>
        ),
      };
    case 'safari-macos':
      return {
        description: 'Safari adds it to your Dock as its own app.',
        body: (
          <p className="text-pretty text-muted-foreground">
            In the menu bar choose <span className={UI}>File › Add to Dock</span>. Then open the new
            app once while BrowserHive is running: from then on it can show you help when
            BrowserHive is stopped.
          </p>
        ),
      };
    default:
      return {
        description: 'This browser has no install button BrowserHive can use.',
        body: (
          <p className="text-pretty text-muted-foreground">
            Look for <span className={UI}>Install</span> or{' '}
            <span className={UI}>Add to Home screen</span> in your browser's menu. If there isn't
            one, this browser can't install websites as apps.
          </p>
        ),
      };
  }
}

/** The dialog; one Close button, a Learn more link to the dashboard guide. */
export function InstallAppDialog({ kind, brand, location, onClose }: InstallAppDialogProps) {
  const shown = kind === null ? null : content(kind, brand, location);
  const Icon = ICONS.installApp;
  return (
    <Dialog open={kind !== null} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent data-install-kind={kind ?? undefined} showCloseButton={false}>
        <DialogHeader className="flex-row items-start gap-3 pr-0">
          <span
            aria-hidden="true"
            className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent-bg text-accent-text"
          >
            <Icon className="size-5" />
          </span>
          <div className="flex min-w-0 flex-col gap-1">
            <DialogTitle>Install BrowserHive</DialogTitle>
            <DialogDescription className="text-pretty">{shown?.description}</DialogDescription>
          </div>
        </DialogHeader>
        {shown !== null ? (
          <DialogBody className="flex min-w-0 flex-col gap-3 text-base">{shown.body}</DialogBody>
        ) : null}
        <DialogFooter className="flex-row items-center justify-between sm:justify-between">
          <a
            href={docsUrl('dashboardInstall')}
            target="_blank"
            rel="noreferrer"
            className={cn(buttonVariants({ variant: 'link', size: 'sm' }), 'px-0')}
          >
            Learn more<span className="sr-only"> about installing BrowserHive</span>
            <ICONS.external aria-hidden="true" />
          </a>
          <Button type="button" variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
