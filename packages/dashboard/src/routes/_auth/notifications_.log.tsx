/** @module routes/_auth/notifications_.log — `/notifications/log`: the delivery log (filters and the open row in the URL; spec 04 §12.11.1) */
import { createFileRoute, stripSearchParams } from '@tanstack/react-router';
import { DeliveryLogPage } from '@/features/notifications/channels/log/DeliveryLogPage.tsx';
import {
  DELIVERY_LOG_DEFAULTS,
  deliveryLogSearch,
} from '@/features/notifications/channels/search.ts';

/** Delivery log. */
export const Route = createFileRoute('/_auth/notifications_/log')({
  component: DeliveryLogPage,
  validateSearch: deliveryLogSearch,
  search: { middlewares: [stripSearchParams(DELIVERY_LOG_DEFAULTS)] },
  staticData: {
    title: 'Delivery log',
    palette: { keywords: ['deliveries', 'sent', 'failed', 'why not sent', 'outbox'] },
  },
});
