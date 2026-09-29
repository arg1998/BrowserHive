/** @module features/notifications/channels/wizard/DiscordDifference — "What's the difference?": Discord webhook mode against bot mode (setup, buttons, connection; D-38), with both message styles drawn live side by side from the same renderer (`POST /channels/preview` with `mode: webhook` and `mode: bot`), and the documented slot for real screenshots of BrowserHive's own messages (`discord-shots.ts`) */
import type { ReactNode } from 'react';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { ICONS } from '@/lib/icons.ts';
import { cn } from '@/lib/utils.ts';
import { useChannelPreview } from '../api.ts';
import { DISCORD_SHOTS, type DiscordShot } from '../discord-shots.ts';
import { PlatformPreview } from '../preview/PlatformPreview.tsx';

const ROWS: readonly {
  readonly label: string;
  readonly webhook: ReactNode;
  readonly bot: ReactNode;
}[] = [
  {
    label: 'Setup',
    webhook: 'About 30 seconds: Channel settings → Integrations → Webhooks → copy the URL.',
    bot: 'About 3 minutes: create an application and a bot in the Developer Portal, invite it, pick the channel.',
  },
  {
    label: 'Alerts, screenshots, updates, self-destruct',
    webhook: 'Yes',
    bot: 'Yes',
  },
  {
    label: 'Buttons',
    webhook: 'Links that open BrowserHive (Take over, Open session).',
    bot: 'Approve, Deny, Mark resolved right in Discord, plus the links.',
  },
  {
    label: 'Connection',
    webhook: 'None: BrowserHive only sends.',
    bot: 'One outgoing connection to Discord while BrowserHive runs.',
  },
  {
    label: 'Available',
    webhook: 'Now',
    bot: 'With the act-buttons release',
  },
];

function Shot({ shot }: { readonly shot: DiscordShot | null }) {
  if (shot === null) return null;
  return (
    <img
      src={shot.src}
      alt={shot.alt}
      loading="lazy"
      className="w-full rounded-lg border object-contain"
    />
  );
}

function ModeColumn({
  mode,
  title,
  badge,
}: {
  readonly mode: 'webhook' | 'bot';
  readonly title: string;
  readonly badge: string;
}) {
  const preview = useChannelPreview({ kind: 'discord', mode, sample: 'attention' });
  return (
    <section aria-label={`${title} message`} className="flex min-w-0 flex-col gap-2">
      <div className="flex items-center gap-2">
        <h3 className="text-base font-semibold">{title}</h3>
        <span
          className={cn(
            'rounded-full px-2 text-xs leading-5 font-medium',
            mode === 'webhook'
              ? 'bg-success-bg text-success-text'
              : 'bg-muted text-muted-foreground',
          )}
        >
          {badge}
        </span>
      </div>
      {preview.data !== undefined ? (
        <PlatformPreview preview={preview.data} compact />
      ) : preview.isError ? (
        <p className="rounded-xl border px-4 py-6 text-sm text-muted-foreground">
          The preview could not be drawn.
        </p>
      ) : (
        <Skeleton className="h-64 w-full rounded-xl" />
      )}
      <Shot shot={DISCORD_SHOTS[mode]} />
    </section>
  );
}

/** Props. */
export interface DiscordDifferenceProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

/** The comparison dialog. */
export function DiscordDifference({ open, onOpenChange }: DiscordDifferenceProps) {
  const Check = ICONS.check;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>Webhook or bot: what's the difference?</DialogTitle>
          <DialogDescription>
            A Discord channel uses one of the two. Both deliver the same alerts; a bot can also take
            your decision from a button. You can switch later without losing the rules.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-6 pb-1">
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full min-w-[36rem] text-sm">
              <thead className="bg-muted/60 text-left dark:bg-white/[0.03]">
                <tr>
                  <th scope="col" className="w-1/4 px-4 py-2 font-medium text-muted-foreground">
                    <span className="sr-only">Aspect</span>
                  </th>
                  <th scope="col" className="px-4 py-2 font-semibold">
                    Webhook <span className="font-normal text-muted-foreground">(default)</span>
                  </th>
                  <th scope="col" className="px-4 py-2 font-semibold">
                    Bot <span className="font-normal text-muted-foreground">(opt-in)</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {ROWS.map((row) => (
                  <tr key={row.label} className="align-top">
                    <th scope="row" className="px-4 py-2.5 text-left font-medium">
                      {row.label}
                    </th>
                    <td className="px-4 py-2.5 text-muted-foreground">
                      {row.webhook === 'Yes' ? (
                        <Check aria-label="Yes" className="size-4 text-success-text" />
                      ) : (
                        row.webhook
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground">
                      {row.bot === 'Yes' ? (
                        <Check aria-label="Yes" className="size-4 text-success-text" />
                      ) : (
                        row.bot
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <ModeColumn mode="webhook" title="Webhook message" badge="available" />
            <ModeColumn mode="bot" title="Bot message" badge="coming later" />
          </div>
          <p className="text-xs text-muted-foreground">
            Both messages are drawn by BrowserHive's own renderer for a sample attention request, in
            the current theme. They are not screenshots of Discord.
          </p>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
