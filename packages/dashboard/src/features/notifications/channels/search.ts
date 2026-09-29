/** @module features/notifications/channels/search — URL search of the channel wizard (`step`, `kind`), the delivery log (`channel`, `status`, `op`, `kind`, `notification`, `seq`, `page`, `ps`) and the act-button audit (`channel`, `outcome`, `page`, `ps`) (spec 04 §1, §12.11.1) */
import {
  NotificationActionOutcome,
  NotificationDeliveryOp,
  NotificationDeliveryStatus,
  NotificationKind,
} from '@browserhive/contracts/enums';
import { AvailableChannelKind } from '@browserhive/contracts/notifications';
import { z } from 'zod';
import { csvParam, pageParam, pageSizeParam, TABLE_SEARCH_DEFAULTS } from '@/lib/search/table.ts';
import { WIZARD_STEPS } from './model.ts';

/** Wizard search (`/notifications/channels/new`, `/notifications/channels/$channelId`). */
export const wizardSearch = z.object({
  step: z.enum(WIZARD_STEPS).optional().catch(undefined),
  kind: AvailableChannelKind.optional().catch(undefined),
  /** A channel id to copy settings from ("Duplicate"). */
  from: z.string().max(80).optional().catch(undefined),
});
/** Wizard search. */
export type WizardSearch = z.infer<typeof wizardSearch>;

/** Delivery log search. */
export const deliveryLogSearch = z.object({
  channel: z.string().max(80).optional().catch(undefined),
  status: csvParam(NotificationDeliveryStatus),
  op: csvParam(NotificationDeliveryOp),
  kind: csvParam(NotificationKind),
  notification: z.string().max(80).optional().catch(undefined),
  /** The delivery whose detail sheet is open. */
  seq: z.coerce.number().int().positive().optional().catch(undefined),
  page: pageParam,
  ps: pageSizeParam,
});
/** Delivery log search. */
export type DeliveryLogSearch = z.infer<typeof deliveryLogSearch>;
/** Defaults omitted from the URL. */
export const DELIVERY_LOG_DEFAULTS = { ...TABLE_SEARCH_DEFAULTS } as const;

/** Act-button audit search (`/notifications/actions`). */
export const actionsSearch = z.object({
  channel: z.string().max(80).optional().catch(undefined),
  outcome: csvParam(NotificationActionOutcome),
  page: pageParam,
  ps: pageSizeParam,
});
/** Act-button audit search. */
export type ActionsSearch = z.infer<typeof actionsSearch>;
/** Defaults omitted from the URL. */
export const ACTIONS_DEFAULTS = { ...TABLE_SEARCH_DEFAULTS } as const;
