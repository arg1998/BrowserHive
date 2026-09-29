/** @module routes/_auth/notifications_.actions — `/notifications/actions`: the act-button audit (filters in the URL; spec 04 §12.11.1, D-41) */
import { createFileRoute, stripSearchParams } from '@tanstack/react-router';
import { ActionsPage } from '@/features/notifications/channels/actions/ActionsPage.tsx';
import { ACTIONS_DEFAULTS, actionsSearch } from '@/features/notifications/channels/search.ts';

/** Act-button audit. */
export const Route = createFileRoute('/_auth/notifications_/actions')({
  component: ActionsPage,
  validateSearch: actionsSearch,
  search: { middlewares: [stripSearchParams(ACTIONS_DEFAULTS)] },
  staticData: {
    title: 'Actions',
    palette: {
      keywords: ['act buttons', 'approve', 'reject', 'answered from chat', 'telegram', 'audit'],
    },
  },
});
