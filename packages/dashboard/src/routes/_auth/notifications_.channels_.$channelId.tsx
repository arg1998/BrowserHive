/** @module routes/_auth/notifications_.channels_.$channelId — `/notifications/channels/$channelId`: one channel, edited in the wizard (read-only for startup channels; spec 04 §12.11.1) */
import { createFileRoute } from '@tanstack/react-router';
import { wizardSearch } from '@/features/notifications/channels/search.ts';
import { EditChannelPage } from '@/features/notifications/channels/wizard/ChannelWizardPage.tsx';

/** One channel. */
export const Route = createFileRoute('/_auth/notifications_/channels_/$channelId')({
  component: EditChannelPage,
  validateSearch: wizardSearch,
  staticData: {
    title: 'Channel',
    crumb: () => 'Channel',
  },
});
