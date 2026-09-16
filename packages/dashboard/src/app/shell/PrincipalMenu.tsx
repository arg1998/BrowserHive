/** @module app/shell/PrincipalMenu — account menu: identity header, Change password, Keyboard shortcuts, Log out (labels live in groups, the menu never throws) */
import { Link } from '@tanstack/react-router';
import { useAuth } from '@/app/providers/AuthProvider.tsx';
import { Avatar, AvatarFallback } from '@/components/ui/avatar.tsx';
import { Button } from '@/components/ui/button.tsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx';
import { ICONS } from '@/lib/icons.ts';

/** Principal menu. */
export function PrincipalMenu({
  compact = false,
  onOpenKeyboardMap,
}: {
  readonly compact?: boolean;
  readonly onOpenKeyboardMap?: () => void;
}) {
  const { state, logout } = useAuth();
  const display = state.principal?.display ?? 'operator';
  const kind = state.principal?.kind ?? 'operator';
  const LogOut = ICONS.logout;
  const Key = ICONS.lock;
  const Keyboard = ICONS.keyboard;
  const Chevron = ICONS.chevronDown;
  const initial = display.slice(0, 1).toUpperCase();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size={compact ? 'icon' : 'default'}
            aria-label={`Account: ${display}`}
            className={compact ? 'rounded-full' : 'gap-2 pr-2 pl-1.5'}
          />
        }
      >
        <Avatar size="sm" className="size-7">
          <AvatarFallback className="bg-accent-bg text-xs font-semibold text-accent-text">
            {initial}
          </AvatarFallback>
        </Avatar>
        {!compact ? (
          <>
            <span className="max-w-32 truncate">{display}</span>
            <Chevron aria-hidden="true" className="size-3.5" />
          </>
        ) : null}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuGroup>
          <div className="flex items-center gap-3 px-2 py-2">
            <Avatar className="size-9">
              <AvatarFallback className="bg-accent-bg text-sm font-semibold text-accent-text">
                {initial}
              </AvatarFallback>
            </Avatar>
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-base font-medium">{display}</span>
              <span className="truncate text-sm text-muted-foreground capitalize">{kind}</span>
            </div>
          </div>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem render={<Link to="/change-password" search={{ voluntary: true }} />}>
            <Key aria-hidden="true" /> Change password
          </DropdownMenuItem>
          {onOpenKeyboardMap !== undefined ? (
            <DropdownMenuItem onClick={onOpenKeyboardMap}>
              <Keyboard aria-hidden="true" /> Keyboard shortcuts
              <DropdownMenuShortcut>?</DropdownMenuShortcut>
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => void logout()}>
          <LogOut aria-hidden="true" /> Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
