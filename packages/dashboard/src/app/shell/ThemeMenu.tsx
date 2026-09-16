/** @module app/shell/ThemeMenu — theme dropdown: Light / Dark / System with a check on the current preference */
import { Button } from '@/components/ui/button.tsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx';
import { Hint } from '@/components/ui/tooltip.tsx';
import { ICONS } from '@/lib/icons.ts';
import type { ThemePreference } from '@/theme/bootstrap.ts';
import { useTheme } from '@/theme/ThemeProvider.tsx';

const OPTIONS: readonly {
  readonly value: ThemePreference;
  readonly label: string;
  readonly icon: 'sun' | 'moon' | 'monitor';
}[] = [
  { value: 'light', label: 'Light', icon: 'sun' },
  { value: 'dark', label: 'Dark', icon: 'moon' },
  { value: 'system', label: 'System', icon: 'monitor' },
];

/** Radio items for the theme (shared by the topbar menu and the account menu). */
export function ThemeRadioItems() {
  const { preference, set } = useTheme();
  return (
    <DropdownMenuRadioGroup
      value={preference}
      onValueChange={(value: unknown) => {
        const option = OPTIONS.find((o) => o.value === value);
        if (option !== undefined) set(option.value);
      }}
    >
      {OPTIONS.map((option) => {
        const Icon = ICONS[option.icon];
        return (
          <DropdownMenuRadioItem key={option.value} value={option.value}>
            <Icon aria-hidden="true" />
            {option.label}
          </DropdownMenuRadioItem>
        );
      })}
    </DropdownMenuRadioGroup>
  );
}

/** Theme menu. */
export function ThemeMenu() {
  const { preference, resolved } = useTheme();
  const Icon = resolved === 'dark' ? ICONS.moon : ICONS.sun;
  return (
    <DropdownMenu>
      <Hint label="Theme">
        <DropdownMenuTrigger
          render={
            <Button type="button" variant="ghost" size="icon" aria-label={`Theme: ${preference}`} />
          }
        >
          <Icon aria-hidden="true" />
        </DropdownMenuTrigger>
      </Hint>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Theme</DropdownMenuLabel>
          <ThemeRadioItems />
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
