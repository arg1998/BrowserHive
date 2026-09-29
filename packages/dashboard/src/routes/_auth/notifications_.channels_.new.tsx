/** @module routes/_auth/notifications_.channels_.new — `/notifications/channels/new`: the add-channel wizard (`?step`, `?kind`, `?from` to duplicate; spec 04 §12.11.1) */
import { createFileRoute } from '@tanstack/react-router';
import { wizardSearch } from '@/features/notifications/channels/search.ts';
import { NewChannelPage } from '@/features/notifications/channels/wizard/ChannelWizardPage.tsx';

/** Add a channel. */
export const Route = createFileRoute('/_auth/notifications_/channels_/new')({
  component: NewChannelPage,
  validateSearch: wizardSearch,
  staticData: {
    title: 'Add a channel',
    palette: { keywords: ['new channel', 'telegram', 'discord', 'ntfy', 'webhook'] },
  },
});
