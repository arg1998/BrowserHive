/** @module app/shell/HelpMenu — topbar help dropdown: the docs section for the current page, guides, keyboard shortcuts, and the project links (website, GitHub, release notes, issues); every outbound item opens in a new tab */
import { useRouterState } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button.tsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx';
import { Hint } from '@/components/ui/tooltip.tsx';
import { ICONS, type IconName } from '@/lib/icons.ts';
import {
  type DocsPage,
  docsUrl,
  ISSUES_URL,
  RELEASES_URL,
  REPO_URL,
  releaseUrl,
  WEBSITE_URL,
} from '@/lib/links.ts';
import { useNavSignals } from './SidebarNav.tsx';

/** Dashboard guide section for a route (`/vault/log` → `dashboardVaultLog`). */
export function pageDocs(pathname: string): { readonly key: DocsPage; readonly label: string } {
  const first = pathname.split('/').filter(Boolean);
  const [top, second] = first;
  switch (top) {
    case 'sessions':
      return second === undefined
        ? { key: 'dashboardSessions', label: 'Sessions' }
        : { key: 'dashboardSessionDetail', label: 'Session detail' };
    case 'attention':
      return { key: 'dashboardAttention', label: 'Attention' };
    case 'websites':
      return { key: 'dashboardWebsites', label: 'Websites' };
    case 'blocklist':
      return { key: 'dashboardBlocklist', label: 'Blocklist' };
    case 'vault':
      return second === 'log'
        ? { key: 'dashboardVaultLog', label: 'Vault log' }
        : { key: 'dashboardVault', label: 'Vault' };
    case 'logs':
      return { key: 'dashboardLogs', label: 'Logs' };
    case 'system':
      return { key: 'dashboardSystem', label: 'System' };
    case 'notifications':
      return { key: 'dashboardNotifications', label: 'Notifications' };
    default:
      return { key: 'dashboardOverview', label: 'Overview' };
  }
}

function ExternalItem({
  href,
  icon,
  children,
}: {
  readonly href: string;
  readonly icon: IconName;
  readonly children: ReactNode;
}) {
  const Icon = ICONS[icon];
  const External = ICONS.external;
  return (
    <DropdownMenuItem render={<a href={href} target="_blank" rel="noreferrer" />}>
      <Icon aria-hidden="true" />
      <span className="flex-1">{children}</span>
      <External aria-hidden="true" className="ml-auto size-3.5 text-subtle-foreground" />
    </DropdownMenuItem>
  );
}

/** Help menu. */
export function HelpMenu({ onOpenKeyboardMap }: { readonly onOpenKeyboardMap: () => void }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { version } = useNavSignals();
  const here = pageDocs(pathname);
  const Help = ICONS.help;
  const Keyboard = ICONS.keyboard;
  return (
    <DropdownMenu>
      <Hint label="Help and docs">
        <DropdownMenuTrigger
          render={<Button type="button" variant="ghost" size="icon" aria-label="Help and docs" />}
        >
          <Help aria-hidden="true" />
        </DropdownMenuTrigger>
      </Hint>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Documentation</DropdownMenuLabel>
          <ExternalItem href={docsUrl(here.key)} icon="book">
            Help for {here.label}
          </ExternalItem>
          <ExternalItem href={docsUrl('dashboard')} icon="overview">
            Dashboard guide
          </ExternalItem>
          <ExternalItem href={docsUrl('mcpClients')} icon="link">
            Connect an MCP client
          </ExternalItem>
          <ExternalItem href={docsUrl('troubleshooting')} icon="tool">
            Troubleshooting
          </ExternalItem>
          <ExternalItem href={docsUrl('home')} icon="layers">
            All documentation
          </ExternalItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={onOpenKeyboardMap}>
            <Keyboard aria-hidden="true" /> Keyboard shortcuts
            <DropdownMenuShortcut>?</DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>BrowserHive</DropdownMenuLabel>
          <ExternalItem href={WEBSITE_URL} icon="globe">
            browserhive.ai
          </ExternalItem>
          <ExternalItem href={REPO_URL} icon="github">
            GitHub repository
          </ExternalItem>
          <ExternalItem href={version !== null ? releaseUrl(version) : RELEASES_URL} icon="rocket">
            {version !== null ? `What's new in v${version}` : 'Release notes'}
          </ExternalItem>
          <ExternalItem href={ISSUES_URL} icon="bug">
            Report an issue
          </ExternalItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
