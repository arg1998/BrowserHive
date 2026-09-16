/** @module app/providers/NotificationsProvider — server-backed notifications: unread count query, `notifications` topic, toasts only from `notification.created` with a per-type policy: no tool-error toasts by default, titles name the session, a growing group updates its toast in place (spec 04 §4.3, D-16) */
import { NotificationType } from '@browserhive/contracts/enums';
import type { Notification } from '@browserhive/contracts/http';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useRouter } from '@tanstack/react-router';
import { createContext, type ReactNode, useContext, useMemo, useRef } from 'react';
import { toAppError } from '@/lib/api/errors.ts';
import { keys } from '@/lib/api/keys.ts';
import { sessionSlug } from '@/lib/format/ids.ts';
import { useServerClock } from '@/lib/server-now.ts';
import { useApi, useAuth } from './AuthProvider.tsx';
import { useTopic } from './SocketProvider.tsx';
import { useToast } from './ToastProvider.tsx';

/** What `useNotifications()` returns. */
export interface NotificationsApi {
  readonly unreadCount: number;
  readonly markRead: (id: Notification['notification_id']) => void;
  readonly dismiss: (id: Notification['notification_id']) => void;
  readonly markAllRead: () => Promise<void>;
  readonly dismissAll: () => Promise<void>;
  /** Route for a notification's Open/Review action. */
  readonly targetOf: (notification: Notification) => string | null;
}

const NotificationsContext = createContext<NotificationsApi | null>(null);

/** Toast ids seen this session, so a reconnect replay never re-toasts (bounded). */
const SEEN_LIMIT = 500;

/**
 * Types that pop a toast when the operator has not chosen their own list. Tool errors are routine
 * (agents retry), so by default they only reach the bell; attention requests, vault confirms,
 * lifecycle and system news toast.
 */
export const DEFAULT_TOAST_TYPES: readonly NotificationType[] = NotificationType.options.filter(
  (type) => type !== 'error',
);

/** A toast the provider should raise for a notification (pure; exported for tests). */
export interface ToastPlan {
  readonly id: string;
  readonly tone: 'error' | 'warning' | 'info';
  readonly title: string;
  readonly description?: string;
  readonly persist: boolean;
  /** Route for the action button, `null` when there is none (or the operator is already there). */
  readonly target: string | null;
}

/** Toast id of a notification (re-issuing it updates the same toast). */
export function notificationToastId(notification: Pick<Notification, 'notification_id'>): string {
  return `n:${notification.notification_id}`;
}

/** The slug naming a notification's session, if it has one. */
function slugOf(notification: Notification): string | null {
  if (notification.session_slug !== null) return notification.session_slug;
  return notification.session_id === null ? null : sessionSlug(notification.session_id);
}

/** Prefix a title with the session slug unless it already names the session. */
function withSession(title: string, slug: string | null): string {
  if (slug === null || title.includes(slug)) return title;
  return `${slug} · ${title}`;
}

/**
 * Decide whether and how a newly created notification toasts (`notification.created` only; a
 * group growing by `notification.updated` never raises a new toast):
 * - the operator's preferences win (`toasts: false`, or an explicit `types` list);
 * - without a stored list, `DEFAULT_TOAST_TYPES` applies (no tool-error toasts);
 * - an error for the session the operator is looking at never toasts (the page shows it);
 * - the title names the session (the daemon's grouped titles already do).
 */
export function planToast(
  notification: Notification,
  context: {
    readonly pathname: string;
    readonly preferences:
      | {
          readonly toasts?: boolean | undefined;
          readonly types?: readonly NotificationType[] | undefined;
        }
      | undefined;
  },
): ToastPlan | null {
  const { preferences } = context;
  if (preferences?.toasts === false) return null;
  const types = preferences?.types ?? DEFAULT_TOAST_TYPES;
  if (!types.includes(notification.type)) return null;
  const target = notificationTarget(notification);
  const here = target !== null && isAlreadyAt(context.pathname, target);
  if (notification.type === 'error' && here) return null;
  const tone =
    notification.type === 'error'
      ? 'error'
      : notification.type === 'attention'
        ? 'warning'
        : 'info';
  return {
    id: notificationToastId(notification),
    tone,
    title: withSession(notification.title, slugOf(notification)),
    ...(notification.body !== null && { description: notification.body }),
    // Only attention requests wait for the operator; errors, lifecycle and vault news fade out.
    persist: notification.type === 'attention',
    target: here ? null : target,
  };
}

/** Is the operator already looking at `target` (same path, or a sub-path of it)? */
export function isAlreadyAt(pathname: string, target: string): boolean {
  const path = target.split(/[?#]/)[0] ?? target;
  return pathname === path || pathname.startsWith(`${path}/`);
}

/** Where a notification leads. */
export function notificationTarget(notification: Notification): string | null {
  if (notification.target !== null) return notification.target;
  if (notification.session_id !== null) return `/sessions/${notification.session_id}`;
  return null;
}

/** Must sit inside `SocketProvider`. */
export function NotificationsProvider({ children }: { readonly children: ReactNode }) {
  const api = useApi();
  const { state: auth } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const router = useRouter();
  const serverClock = useServerClock();
  const toasted = useRef(new Set<string>());
  const seen = useRef<{ readonly set: Set<string>; readonly order: string[] }>({
    set: new Set(),
    order: [],
  });
  const ready = auth.status === 'ready';

  const unread = useQuery({
    queryKey: keys.notifications.unreadCount(),
    queryFn: async () => {
      const page = await api.listNotifications({ query: { read: 'unread', limit: 1 } });
      return page.unread_count;
    },
    enabled: ready,
  });
  // The operator's toast preferences (Notifications page) decide whether a new one pops up.
  const preferences = useQuery({
    queryKey: keys.preferences(),
    queryFn: () => api.getPreferences(),
    enabled: ready,
  });

  useTopic(ready ? 'notifications' : null, (event) => {
    if (event.type !== 'notification.created' && event.type !== 'notification.updated') return;
    const { notification } = event;
    const id = notificationToastId(notification);
    if (event.type === 'notification.updated') {
      // A growing group updates its toast in place while it is still shown; read or dismissed
      // elsewhere (bell, another tab) closes it. Never a new toast.
      if (!toasted.current.has(notification.notification_id)) return;
      if (notification.read_at !== null || notification.dismissed_at !== null) toast.close(id);
      else
        toast.update(id, {
          title: withSession(notification.title, slugOf(notification)),
          ...(notification.body !== null && { description: notification.body }),
        });
      return;
    }
    if (seen.current.set.has(notification.notification_id)) return;
    seen.current.set.add(notification.notification_id);
    seen.current.order.push(notification.notification_id);
    if (seen.current.order.length > SEEN_LIMIT) {
      const oldest = seen.current.order.shift();
      if (oldest !== undefined) {
        seen.current.set.delete(oldest);
        toasted.current.delete(oldest);
      }
    }
    const plan = planToast(notification, {
      pathname: router.state.location.pathname,
      preferences: preferences.data?.preferences.notifications,
    });
    if (plan === null) return;
    toasted.current.add(notification.notification_id);
    const target = plan.target;
    toast[plan.tone]({
      id: plan.id,
      title: plan.title,
      persist: plan.persist,
      ...(plan.description !== undefined && { description: plan.description }),
      // No "Open session" button when the operator is already on that page.
      ...(target !== null && {
        action: {
          label: notification.type === 'vault' ? 'Review in vault' : 'Open session',
          onClick: () => void navigate({ to: target }),
        },
      }),
    });
  });

  const patchLists = (id: string, patch: Partial<Notification>) => {
    queryClient.setQueriesData({ queryKey: keys.notifications.lists() }, (data: unknown) => {
      if (typeof data !== 'object' || data === null || !('data' in data)) return data;
      const page = data as { data: Notification[]; unread_count?: number };
      return {
        ...page,
        data: page.data.map((n) => (n.notification_id === id ? { ...n, ...patch } : n)),
      };
    });
  };

  const markRead = useMutation({
    mutationFn: (id: Notification['notification_id']) =>
      api.markNotificationRead({ params: { notification_id: id } }),
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: keys.notifications.all });
      const snapshot = queryClient.getQueriesData({ queryKey: keys.notifications.all });
      patchLists(id, { read_at: serverClock.now() });
      queryClient.setQueryData(keys.notifications.unreadCount(), (n: number | undefined) =>
        n === undefined ? n : Math.max(0, n - 1),
      );
      return { snapshot };
    },
    onError: (error, _id, context) => {
      for (const [key, data] of context?.snapshot ?? []) queryClient.setQueryData(key, data);
      toast.fromError(toAppError(error), 'Could not mark as read');
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.notifications.all }),
  });

  const dismiss = useMutation({
    mutationFn: (id: Notification['notification_id']) =>
      api.dismissNotification({ params: { notification_id: id } }),
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: keys.notifications.all });
      const snapshot = queryClient.getQueriesData({ queryKey: keys.notifications.all });
      patchLists(id, { dismissed_at: serverClock.now() });
      return { snapshot };
    },
    onError: (error, _id, context) => {
      for (const [key, data] of context?.snapshot ?? []) queryClient.setQueryData(key, data);
      toast.fromError(toAppError(error), 'Could not dismiss');
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.notifications.all }),
  });

  const value = useMemo<NotificationsApi>(
    () => ({
      unreadCount: unread.data ?? 0,
      markRead: (id) => markRead.mutate(id),
      dismiss: (id) => dismiss.mutate(id),
      markAllRead: async () => {
        await api.markAllNotificationsRead();
        await queryClient.invalidateQueries({ queryKey: keys.notifications.all });
      },
      dismissAll: async () => {
        await api.dismissAllNotifications();
        await queryClient.invalidateQueries({ queryKey: keys.notifications.all });
      },
      targetOf: notificationTarget,
    }),
    [unread.data, markRead, dismiss, api, queryClient],
  );

  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}

/** Notification state and actions. */
export function useNotifications(): NotificationsApi {
  const value = useContext(NotificationsContext);
  if (value === null) throw new Error('useNotifications() requires NotificationsProvider');
  return value;
}
