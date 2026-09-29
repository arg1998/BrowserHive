/** @module features/notifications/channels/platforms — the platforms the setup offers (available and upcoming), their marks (our own glyphs on a tinted tile, never platform logos), taglines, setup facts and docs anchors */
import type { AvailableChannelKind } from '@browserhive/contracts/notifications';
import { ICONS, type IconName } from '@/lib/icons.ts';
import type { DocsPage } from '@/lib/links.ts';
import { cn } from '@/lib/utils.ts';

/** What the setup says about one platform. */
export interface PlatformInfo {
  readonly kind: AvailableChannelKind;
  readonly label: string;
  readonly icon: IconName;
  /** One line under the name on the platform card. */
  readonly tagline: string;
  /** Rough setup time. */
  readonly setup: string;
  readonly facts: readonly string[];
  readonly docs: DocsPage;
  /** Tailwind classes of the mark tile. */
  readonly tile: string;
}

/** Available platforms, in the order the setup shows them. */
export const PLATFORMS: readonly PlatformInfo[] = [
  {
    kind: 'telegram',
    label: 'Telegram',
    icon: 'platformTelegram',
    tagline: 'Your own bot messages you, a group or a topic.',
    setup: 'About 2 minutes',
    facts: ['Screenshots', 'Updates in place', 'Self-destruct up to 47 h'],
    docs: 'channelTelegram',
    tile: 'bg-platform-telegram-bg text-platform-telegram',
  },
  {
    kind: 'discord',
    label: 'Discord',
    icon: 'platformDiscord',
    tagline: 'A webhook posts into one channel of your server.',
    setup: 'About 30 seconds',
    facts: ['Screenshots', 'Updates in place', 'Self-destruct'],
    docs: 'channelDiscord',
    tile: 'bg-platform-discord-bg text-platform-discord',
  },
  {
    kind: 'ntfy',
    label: 'ntfy',
    icon: 'platformNtfy',
    tagline: 'Push notifications through ntfy.sh or your own server.',
    setup: 'About 1 minute',
    facts: ['No account needed', 'Updates in place', 'Self-destruct'],
    docs: 'channelNtfy',
    tile: 'bg-platform-ntfy-bg text-platform-ntfy',
  },
  {
    kind: 'webhook',
    label: 'Webhook',
    icon: 'platformWebhook',
    tagline: 'POSTs the notification as signed JSON to your URL.',
    setup: 'For your own tools',
    facts: ['HMAC signature', 'Full message contract', 'Home Assistant, n8n…'],
    docs: 'channelWebhook',
    tile: 'bg-platform-webhook-bg text-platform-webhook',
  },
];

/** Platforms on the roadmap, shown disabled so users know they are coming. */
export const UPCOMING_PLATFORMS: readonly { readonly label: string; readonly note: string }[] = [
  { label: 'Slack', note: 'Coming later' },
  { label: 'Pushover', note: 'Coming later' },
  { label: 'Microsoft Teams', note: 'Coming later' },
  { label: 'Email', note: 'Coming later' },
];

/** The info of an available platform (a fallback for unknown kinds). */
export function platformOf(kind: string): PlatformInfo {
  return (
    PLATFORMS.find((p) => p.kind === kind) ?? {
      kind: 'webhook',
      label: kind,
      icon: 'channels',
      tagline: '',
      setup: '',
      facts: [],
      docs: 'notificationChannels',
      tile: 'bg-muted text-muted-foreground',
    }
  );
}

/** A platform's mark: its glyph on a tinted rounded tile. */
export function PlatformMark({
  kind,
  size = 'md',
  className,
}: {
  readonly kind: string;
  readonly size?: 'sm' | 'md' | 'lg';
  readonly className?: string;
}) {
  const info = platformOf(kind);
  const Icon = ICONS[info.icon];
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-lg',
        size === 'sm' && 'size-7 [&_svg]:size-3.5',
        size === 'md' && 'size-9 [&_svg]:size-[1.125rem]',
        size === 'lg' && 'size-11 rounded-xl [&_svg]:size-5',
        info.tile,
        className,
      )}
    >
      <Icon />
    </span>
  );
}
