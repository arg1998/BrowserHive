/** @module features/notifications/channels/wizard/TimeZonePicker — a searchable IANA time zone picker for a channel (D-43): "Same as BrowserHive (<host zone>)" first (the default, stored as no zone), the browser's zone next when it differs, then every zone the browser knows; typing filters by city or region */
import { Combobox } from '@base-ui/react/combobox';
import { useMemo } from 'react';
import { fieldClasses } from '@/components/ui/input.tsx';
import { ICONS } from '@/lib/icons.ts';
import { cn } from '@/lib/utils.ts';
import { browserZone, timeZones, zoneLabel } from '../model.ts';

/** The item that means "the host's zone" (no `rules.time_zone`). */
export const HOST_ZONE_ITEM = '(host)';

/** Props. */
export interface TimeZonePickerProps {
  readonly id: string;
  /** The channel's zone, or `undefined` for the host's. */
  readonly value: string | undefined;
  /** The zone BrowserHive runs in (`GET /channels` `host_time_zone`). */
  readonly hostZone: string;
  readonly disabled?: boolean;
  readonly onChange: (zone: string | undefined) => void;
  readonly describedBy?: string;
}

/** The time zone picker. */
export function TimeZonePicker({
  id,
  value,
  hostZone,
  disabled = false,
  onChange,
  describedBy,
}: TimeZonePickerProps) {
  const browser = browserZone();
  const items = useMemo(() => {
    const zones = timeZones();
    const first = [HOST_ZONE_ITEM, ...(browser !== hostZone ? [browser] : [])];
    return [...first, ...zones.filter((z) => !first.includes(z))];
  }, [browser, hostZone]);
  const label = (item: string) =>
    item === HOST_ZONE_ITEM
      ? `Same as BrowserHive (${zoneLabel(hostZone)})`
      : item === browser && browser !== hostZone
        ? `${zoneLabel(item)} (this browser)`
        : zoneLabel(item);
  const Chevron = ICONS.chevronDown;
  const Check = ICONS.check;
  return (
    <Combobox.Root<string>
      items={items}
      value={value ?? HOST_ZONE_ITEM}
      disabled={disabled}
      itemToStringLabel={label}
      onValueChange={(next) => {
        if (next === null) return;
        onChange(next === HOST_ZONE_ITEM ? undefined : next);
      }}
    >
      <Combobox.InputGroup className="relative">
        <Combobox.Input
          id={id}
          aria-describedby={describedBy}
          placeholder="Search a city or region"
          className={cn(fieldClasses, 'h-9 pr-9 pl-3 pointer-coarse:h-10')}
        />
        <Combobox.Trigger
          aria-label="Show time zones"
          className="absolute inset-y-0 right-0 flex w-9 cursor-pointer items-center justify-center rounded-r-md text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          <Chevron aria-hidden="true" className="size-4" />
        </Combobox.Trigger>
      </Combobox.InputGroup>
      <Combobox.Portal>
        <Combobox.Positioner className="isolate z-50" sideOffset={4}>
          <Combobox.Popup className="max-h-[min(20rem,var(--available-height))] w-(--anchor-width) min-w-64 origin-(--transform-origin) overflow-y-auto overscroll-contain rounded-lg bg-popover p-1 text-popover-foreground shadow-popover data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95">
            <Combobox.Empty>
              <p className="px-2 py-3 text-sm text-muted-foreground">No time zone matches.</p>
            </Combobox.Empty>
            <Combobox.List>
              {(item: string) => (
                <Combobox.Item
                  key={item}
                  value={item}
                  className="relative flex min-h-8 cursor-pointer items-center gap-2 rounded-md py-1.5 pr-8 pl-2 text-sm outline-hidden select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground pointer-coarse:min-h-10"
                >
                  <span
                    className={cn(
                      'min-w-0 flex-1 truncate',
                      item === HOST_ZONE_ITEM && 'font-medium',
                    )}
                  >
                    {label(item)}
                  </span>
                  <Combobox.ItemIndicator className="absolute right-2 flex size-4 items-center justify-center">
                    <Check aria-hidden="true" className="size-4 text-primary" />
                  </Combobox.ItemIndicator>
                </Combobox.Item>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
