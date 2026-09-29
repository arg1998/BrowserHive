/** @module routes/_auth/notifications_.channels — `/notifications/channels`: notification channels (un-nested from `/notifications`, spec 04 §12.11.1) */
import { createFileRoute } from '@tanstack/react-router';
import { ChannelsPage } from '@/features/notifications/channels/ChannelsPage.tsx';

/** Notification channels. */
export const Route = createFileRoute('/_auth/notifications_/channels')({
  component: ChannelsPage,
  staticData: {
    title: 'Channels',
    palette: {
      keywords: ['telegram', 'discord', 'ntfy', 'webhook', 'phone', 'push', 'alerts', 'channels'],
    },
  },
});
