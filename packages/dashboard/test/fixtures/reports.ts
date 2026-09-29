/** @module test/fixtures/reports — report messages as the server builds them (generated from the core samples at the `full` level: a daily digest, a late weekly digest, an anomaly alert) and report items for the Reports tab tests (D-45) */
import type { Notification, ReportItem } from '@browserhive/contracts/http';
import type { NotificationMessage } from '@browserhive/contracts/notifications';

/** A daily digest (Tue 29 Sep, Europe/Berlin). */
export const DIGEST_MESSAGE = {
  schema: 1,
  id: 'n-digest000001',
  revision: 1,
  thread: 'report:digest:day@09:00@Europe/Berlin:1790578800000:1790665200000',
  kind: 'digest.daily',
  category: 'reports',
  severity: 'info',
  state: 'final',
  alert: false,
  at: { created: 1790665200000, updated: 1790665200000 },
  title: 'Daily digest \u00b7 Tue 29 Sep',
  summary: '12 sessions (2 live) \u00b7 3,412 tool calls \u00b7 68 errors (2%)',
  blocks: [
    {
      type: 'fields',
      items: [
        { label: 'Sessions', value: [{ type: 'text', text: '12 started \u00b7 2 live now' }] },
        {
          label: 'Tool calls',
          value: [
            { type: 'text', text: '3,412 \u00b7 68 errors (2%)' },
            { type: 'text', text: ' \u00b7 was 1.2%' },
          ],
        },
        {
          label: 'Attention',
          value: [
            {
              type: 'text',
              text: '4 requests \u00b7 3 answered (median 1m 36s) \u00b7 1 timed out',
            },
          ],
        },
        {
          label: 'Vault fills',
          value: [{ type: 'text', text: '9 \u00b7 8 ok \u00b7 1 origin mismatch' }],
        },
        {
          label: 'Blocked requests',
          value: [
            { type: 'text', text: '27' },
            { type: 'text', text: ' \u00b7 top ' },
            { type: 'code', text: '*.doubleclick.net' },
            { type: 'text', text: ' (19)' },
            { type: 'text', text: ' \u00b7 most blocked ' },
            { type: 'code', text: 'ads.example.net' },
            { type: 'text', text: ' (12)' },
          ],
        },
        {
          label: 'Slowest tool (p95)',
          value: [
            { type: 'code', text: 'navigate' },
            { type: 'text', text: ' 4.2 s (was 2.9 s)' },
          ],
        },
        {
          label: 'Open problems',
          value: [
            { type: 'code', text: 'RETENTION_FAILED' },
            { type: 'text', text: ' since 29 Sep 03:00' },
          ],
        },
      ],
    },
    {
      type: 'chart',
      label: 'Tool calls per hour',
      values: [
        2, 1, 0, 0, 0, 1, 4, 18, 96, 212, 305, 280, 190, 240, 330, 412, 380, 260, 150, 120, 88, 60,
        40, 23,
      ],
      start: 1790578800000,
      step_ms: 3600000,
      unit: 'calls',
    },
    { type: 'heading', text: 'Top errors' },
    {
      type: 'table',
      columns: ['Error', 'Tool', 'Count', 'Sessions'],
      rows: [
        [
          [{ type: 'code', text: 'NAVIGATION_TIMEOUT' }],
          [{ type: 'code', text: 'navigate' }],
          [{ type: 'text', text: '31' }],
          [{ type: 'text', text: '4' }],
        ],
        [
          [{ type: 'code', text: 'ELEMENT_NOT_FOUND' }],
          [{ type: 'code', text: 'click' }],
          [{ type: 'text', text: '22' }],
          [{ type: 'text', text: '6' }],
        ],
        [
          [{ type: 'code', text: 'CAPTCHA_DETECTED' }],
          [{ type: 'code', text: 'navigate' }],
          [{ type: 'text', text: '15' }],
          [{ type: 'text', text: '2' }],
        ],
      ],
    },
    { type: 'heading', text: 'By harness' },
    {
      type: 'table',
      columns: ['Harness', 'Sessions', 'Tool calls', 'Errors'],
      rows: [
        [
          [{ type: 'text', text: 'Claude Code' }],
          [{ type: 'text', text: '8' }],
          [{ type: 'text', text: '2,410' }],
          [{ type: 'text', text: '51' }],
        ],
        [
          [{ type: 'text', text: 'Cursor' }],
          [{ type: 'text', text: '3' }],
          [{ type: 'text', text: '880' }],
          [{ type: 'text', text: '15' }],
        ],
        [
          [{ type: 'text', text: 'Unknown' }],
          [{ type: 'text', text: '1' }],
          [{ type: 'text', text: '122' }],
          [{ type: 'text', text: '2' }],
        ],
      ],
    },
    {
      type: 'list',
      ordered: false,
      items: [
        [
          { type: 'bold', text: 'RETENTION_FAILED' },
          { type: 'text', text: ' since 29 Sep 03:00: retention sweep failed: database is locked' },
        ],
      ],
    },
    {
      type: 'footer',
      content: [{ type: 'text', text: '28 Sep 09:00 \u2192 29 Sep 09:00 \u00b7 Europe/Berlin' }],
    },
  ],
  actions: [
    {
      kind: 'open',
      id: 'overview',
      label: 'Open Overview',
      style: 'primary',
      path: '/overview?since=1790578800000&until=1790665200000',
    },
  ],
  entities: {},
  privacy: { level: 'full', has_image: false },
  report: {
    window: { since: 1790578800000, until: 1790665200000 },
    time_zone: 'Europe/Berlin',
    late: false,
    skipped: 0,
    manual: false,
  },
} as unknown as NotificationMessage;

/** A weekly digest, sent late with two skipped. */
export const WEEKLY_MESSAGE = {
  schema: 1,
  id: 'n-weekly000001',
  revision: 1,
  thread: 'report:digest:week:fri@17:00@Europe/Berlin:1:2',
  kind: 'digest.weekly',
  category: 'reports',
  severity: 'info',
  state: 'final',
  alert: false,
  at: { created: 1790665200000, updated: 1790665200000 },
  title: 'Weekly digest \u00b7 22\u201329 Sep',
  summary: '84 sessions (2 live) \u00b7 23,884 tool calls \u00b7 476 errors (2%)',
  blocks: [
    {
      type: 'text',
      content: [
        { type: 'text', text: 'Sent late: BrowserHive was not running at 09:00 (Tue 29 Sep).' },
        { type: 'text', text: ' 2 earlier weekly digests were skipped while BrowserHive was off.' },
      ],
    },
    {
      type: 'fields',
      items: [
        { label: 'Sessions', value: [{ type: 'text', text: '84 started \u00b7 2 live now' }] },
        {
          label: 'Tool calls',
          value: [
            { type: 'text', text: '23,884 \u00b7 476 errors (2%)' },
            { type: 'text', text: ' \u00b7 was 1.2%' },
          ],
        },
        {
          label: 'Attention',
          value: [
            {
              type: 'text',
              text: '28 requests \u00b7 21 answered (median 1m 36s) \u00b7 7 timed out',
            },
          ],
        },
        {
          label: 'Vault fills',
          value: [{ type: 'text', text: '63 \u00b7 56 ok \u00b7 7 origin mismatch' }],
        },
        {
          label: 'Blocked requests',
          value: [
            { type: 'text', text: '189' },
            { type: 'text', text: ' \u00b7 top ' },
            { type: 'code', text: '*.doubleclick.net' },
            { type: 'text', text: ' (133)' },
            { type: 'text', text: ' \u00b7 most blocked ' },
            { type: 'code', text: 'ads.example.net' },
            { type: 'text', text: ' (84)' },
          ],
        },
        {
          label: 'Slowest tool (p95)',
          value: [
            { type: 'code', text: 'navigate' },
            { type: 'text', text: ' 4.2 s (was 2.9 s)' },
          ],
        },
        {
          label: 'Open problems',
          value: [
            { type: 'code', text: 'RETENTION_FAILED' },
            { type: 'text', text: ' since 29 Sep 03:00' },
          ],
        },
      ],
    },
    {
      type: 'chart',
      label: 'Tool calls per 12 hours',
      values: [10, 5, 0, 0, 0, 5, 20, 90, 480, 1060, 1525, 1400, 950, 1200],
      start: 1790060400000,
      step_ms: 43200000,
      unit: 'calls',
    },
    { type: 'heading', text: 'Top errors' },
    {
      type: 'table',
      columns: ['Error', 'Tool', 'Count', 'Sessions'],
      rows: [
        [
          [{ type: 'code', text: 'NAVIGATION_TIMEOUT' }],
          [{ type: 'code', text: 'navigate' }],
          [{ type: 'text', text: '217' }],
          [{ type: 'text', text: '4' }],
        ],
        [
          [{ type: 'code', text: 'ELEMENT_NOT_FOUND' }],
          [{ type: 'code', text: 'click' }],
          [{ type: 'text', text: '154' }],
          [{ type: 'text', text: '6' }],
        ],
        [
          [{ type: 'code', text: 'CAPTCHA_DETECTED' }],
          [{ type: 'code', text: 'navigate' }],
          [{ type: 'text', text: '105' }],
          [{ type: 'text', text: '2' }],
        ],
      ],
    },
    { type: 'heading', text: 'By harness' },
    {
      type: 'table',
      columns: ['Harness', 'Sessions', 'Tool calls', 'Errors'],
      rows: [
        [
          [{ type: 'text', text: 'Claude Code' }],
          [{ type: 'text', text: '56' }],
          [{ type: 'text', text: '16,870' }],
          [{ type: 'text', text: '357' }],
        ],
        [
          [{ type: 'text', text: 'Cursor' }],
          [{ type: 'text', text: '21' }],
          [{ type: 'text', text: '6,160' }],
          [{ type: 'text', text: '105' }],
        ],
        [
          [{ type: 'text', text: 'Unknown' }],
          [{ type: 'text', text: '7' }],
          [{ type: 'text', text: '854' }],
          [{ type: 'text', text: '14' }],
        ],
      ],
    },
    {
      type: 'list',
      ordered: false,
      items: [
        [
          { type: 'bold', text: 'RETENTION_FAILED' },
          { type: 'text', text: ' since 29 Sep 03:00: retention sweep failed: database is locked' },
        ],
      ],
    },
    {
      type: 'footer',
      content: [{ type: 'text', text: '22 Sep 09:00 \u2192 29 Sep 09:00 \u00b7 Europe/Berlin' }],
    },
  ],
  actions: [
    {
      kind: 'open',
      id: 'overview',
      label: 'Open Overview',
      style: 'primary',
      path: '/overview?since=1790060400000&until=1790665200000',
    },
  ],
  entities: {},
  privacy: { level: 'full', has_image: false },
  report: {
    window: { since: 1790060400000, until: 1790665200000 },
    time_zone: 'Europe/Berlin',
    late: true,
    skipped: 2,
    manual: false,
  },
} as unknown as NotificationMessage;

/** An anomaly alert, open. */
export const ANOMALY_MESSAGE = {
  schema: 1,
  id: 'n-anomaly00001',
  revision: 1,
  thread: 'report:anomaly:abcd1234:1790683200000',
  kind: 'report.anomaly',
  category: 'reports',
  severity: 'warn',
  state: 'open',
  alert: true,
  at: { created: 1790683200000, updated: 1790683200000 },
  title: 'Something looks off: 2 checks',
  summary:
    '34% of tool calls failed in the last hour \u00b7 An attention request has waited 47 min',
  blocks: [
    {
      type: 'table',
      columns: ['Check', 'Now', 'Threshold', 'Since'],
      rows: [
        [
          [
            { type: 'text', text: 'Tool-call error rate' },
            { type: 'text', text: ' ' },
            { type: 'bold', text: 'new' },
          ],
          [{ type: 'text', text: '34%' }],
          [{ type: 'text', text: '\u2265 20%' }],
          [{ type: 'text', text: '14:00' }],
        ],
        [
          [
            { type: 'text', text: 'Attention waiting' },
            { type: 'text', text: ' ' },
            { type: 'bold', text: 'new' },
          ],
          [{ type: 'text', text: '47 min' }],
          [{ type: 'text', text: '\u2265 30 min' }],
          [{ type: 'text', text: '14:00' }],
        ],
      ],
    },
    {
      type: 'text',
      content: [
        { type: 'text', text: 'Waiting: ' },
        { type: 'code', text: 'checkout' },
      ],
    },
    {
      type: 'footer',
      content: [{ type: 'text', text: 'Checked 13:00\u201314:00 \u00b7 Europe/Berlin' }],
    },
  ],
  actions: [
    {
      kind: 'open',
      id: 'overview',
      label: 'Open Overview',
      style: 'primary',
      path: '/overview?range=24h',
    },
  ],
  entities: {},
  privacy: { level: 'full', has_image: false },
  report: {
    window: { since: 1790679600000, until: 1790683200000 },
    time_zone: 'Europe/Berlin',
    late: false,
    skipped: 0,
    manual: false,
  },
} as unknown as NotificationMessage;

/** The in-app row of a report message. */
export function reportNotification(
  message: NotificationMessage,
  overrides: Partial<Notification> = {},
): Notification {
  const digest = message.kind !== 'report.anomaly';
  return {
    notification_id: message.id as Notification['notification_id'],
    principal_id: null,
    type: digest ? 'lifecycle' : 'system',
    title: message.title,
    body: message.summary,
    session_id: null,
    session_slug: null,
    target: `/notifications/reports/${message.id}`,
    source_event_id: null,
    created_at: message.at.created,
    updated_at: message.at.created,
    count: 1,
    read_at: digest ? message.at.created : null,
    dismissed_at: null,
    kind: message.kind,
    category: 'reports',
    severity: message.severity,
    state: message.state,
    revision: message.revision,
    thread: message.thread,
    ...overrides,
  };
}

/** A report item of the history. */
export function reportItem(
  message: NotificationMessage,
  channels: ReportItem['channels'] = [],
  overrides: Partial<Notification> = {},
): ReportItem {
  return {
    notification: reportNotification(message, overrides),
    report: message.report ?? null,
    channels,
  };
}
