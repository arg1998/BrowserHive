/** @module features/notifications/NotificationsNav — the Notifications area's section nav (Inbox · Channels · Delivery log · Actions · Reports): underline tabs made of real links under the page header (spec 04 §12.11.1) */
import { Link, useRouterState } from '@tanstack/react-router';
import { ICONS, type IconName } from '@/lib/icons.ts';
import { cn } from '@/lib/utils.ts';

const SECTIONS: readonly {
  readonly to: string;
  readonly label: string;
  readonly icon: IconName;
}[] = [
  { to: '/notifications', label: 'Inbox', icon: 'inbox' },
  { to: '/notifications/channels', label: 'Channels', icon: 'channels' },
  { to: '/notifications/log', label: 'Delivery log', icon: 'deliveryLog' },
  { to: '/notifications/actions', label: 'Actions', icon: 'actions' },
  { to: '/notifications/reports', label: 'Reports', icon: 'reports' },
];

/** Which section a pathname belongs to. */
export function activeSection(pathname: string): string {
  if (pathname.startsWith('/notifications/channels')) return '/notifications/channels';
  if (pathname.startsWith('/notifications/log')) return '/notifications/log';
  if (pathname.startsWith('/notifications/actions')) return '/notifications/actions';
  if (pathname.startsWith('/notifications/reports')) return '/notifications/reports';
  return '/notifications';
}

/** Section nav (pass as `PageHeader` `tabs`). */
export function NotificationsNav() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const active = activeSection(pathname);
  return (
    <nav
      aria-label="Notifications sections"
      className="-mx-2 flex h-10 w-[calc(100%+1rem)] items-stretch gap-5 overflow-x-auto overflow-y-hidden bg-[linear-gradient(var(--border),var(--border))] bg-size-[calc(100%-1rem)_1px] bg-position-[0.5rem_100%] bg-no-repeat px-2 [scrollbar-width:none]"
    >
      {SECTIONS.map((section) => {
        const Icon = ICONS[section.icon];
        const current = section.to === active;
        return (
          <Link
            key={section.to}
            to={section.to}
            aria-current={current ? 'page' : undefined}
            className={cn(
              'relative my-1 inline-flex h-8 items-center gap-2 rounded-xs px-0.5 text-base font-medium whitespace-nowrap transition-colors duration-(--duration-fast) focus-ring',
              current ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon aria-hidden="true" className="size-4" />
            {section.label}
            {current ? (
              <span
                aria-hidden="true"
                className="absolute inset-x-0 -bottom-1 h-0.5 rounded-full bg-foreground"
              />
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
