/** @module features/templates/detail/DeviceBoundBadge — the "Device-bound" badge of a site on the Sites tab (spec 13 §2.3, §9.4 `device-bound-session`, §11.4): the site binds its sign-in to this device, so the template cannot move to another machine */
import { Chip } from '@/components/shared/Chip.tsx';
import { Hint } from '@/components/ui/tooltip.tsx';
import { ICONS } from '@/lib/icons.ts';

/** What the badge means, for the tooltip and screen readers. */
export const DEVICE_BOUND_HINT =
  'The site binds its sign-in to this device. It cannot move to another machine: a copy of the template signs out there.';

/** The badge; nothing when the site is not device-bound. */
export function DeviceBoundBadge({ bound }: { readonly bound: boolean }) {
  if (!bound) return null;
  const Icon = ICONS.device;
  return (
    <Hint label={DEVICE_BOUND_HINT}>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: focusable so keyboard users get the tooltip too */}
      <span tabIndex={0} className="shrink-0 rounded-md focus-ring" data-testid="device-bound">
        <Chip tone="info">
          <Icon aria-hidden="true" className="size-3.5" />
          Device-bound
          <span className="sr-only">: {DEVICE_BOUND_HINT}</span>
        </Chip>
      </span>
    </Hint>
  );
}
