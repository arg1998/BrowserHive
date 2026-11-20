/** @module app/notifications/producers-templates — the session-template producer rules (spec 13 §8.6): sign-outs and challenges per template and identity provider, failed re-logins, failed browsers, and the revisions that resolve them. */

import {
  KIND_SEVERITY,
  type NotificationAction,
  type NotificationEntities,
} from '@browserhive/contracts/notifications';
import type { DomainEvents, SigninTransition } from '../events/catalog.ts';
import { clip, code, link, type MessageContent, text, time } from './message.ts';
import type { NotificationDraft, ThreadRevision } from './producer-types.ts';

/** The thread of a template's identity provider (spec 13 §8.6). */
export function providerThread(templateId: string, provider: string): string {
  return `template:${templateId}:${provider}`;
}

/** The thread of a template's browser. */
export function hostThread(templateId: string): string {
  return `template-host:${templateId}`;
}

/** The kinds of a provider's sign-in thread. */
const SIGNIN_KINDS = ['template.signed_out', 'template.challenged'] as const;
const LABEL_MAX = 40;
const TITLE_MAX = 120;

function templatePath(templateId: string, site?: string): string {
  return site === undefined
    ? `/templates/${templateId}`
    : `/templates/${templateId}?site=${encodeURIComponent(site)}`;
}

function entities(templateId: string, name: string, site?: string): NotificationEntities {
  return {
    template_id: templateId,
    template_name: name,
    ...(site !== undefined && { domain: site }),
  };
}

/** "linkedin.com" or "Indeed login (covers indeed.com, glassdoor.com)". */
function providerText(t: SigninTransition): string {
  return t.covers.length > 1 ? `${t.provider} login (covers ${t.covers.join(', ')})` : t.provider;
}

/** `template.health` with a sign-in transition: a sign-out or a challenge opens the provider's thread. */
export function signinDraft(payload: DomainEvents['template.health']): NotificationDraft | null {
  const t = payload.transition;
  if (t === undefined || (t.to !== 'signed_out' && t.to !== 'challenged')) return null;
  const id = payload.template_id;
  const site = payload.site.site_id;
  const path = templatePath(id, site);
  const signedOut = t.to === 'signed_out';
  const kind = signedOut ? ('template.signed_out' as const) : ('template.challenged' as const);
  const title = clip(
    `${t.template.display_name}: ${t.provider} ${signedOut ? 'signed out' : 'needs a check'}`,
    TITLE_MAX,
  );
  const summary = signedOut
    ? `${providerText(t)} is signed out. Sign in again so sessions of this template start signed in.`
    : `${providerText(t)} shows a security check. A person needs to solve it.`;
  const actions: NotificationAction[] = [];
  if (signedOut) {
    actions.push({
      kind: 'act',
      id: 'relogin',
      label: clip(`Re-login on ${t.machine}`, LABEL_MAX),
      style: 'primary',
      command: { op: 'template.relogin', args: { template_id: id, site_id: site } },
      confirm: null,
      fallback: { label: 'Open template', path },
    });
  }
  // A session's challenge (spec 13 §8.6, D45): with a takeover request open on it the operator can
  // take over its page; a `notify` challenge opened none, so the session can only be watched
  // (review #93 M1).
  const session = signedOut ? undefined : t.session_id;
  const takeover = session !== undefined && t.session_takeover === true;
  if (session !== undefined) {
    const live = `/sessions/${encodeURIComponent(session)}?live=1`;
    actions.push(
      takeover
        ? {
            kind: 'open',
            id: 'take-over',
            label: 'Take over',
            style: 'primary',
            path: `${live}&takeover=1`,
          }
        : { kind: 'open', id: 'watch-live', label: 'Watch live', style: 'default', path: live },
    );
  }
  actions.push({
    kind: 'open',
    id: 'open-template',
    label: 'Open template',
    style: signedOut || takeover ? 'default' : 'primary',
    path,
  });
  return {
    type: 'attention',
    kind,
    severity: KIND_SEVERITY[kind],
    state: 'open',
    thread: providerThread(id, t.provider),
    title,
    body: summary,
    sessionId: session ?? null,
    target: path,
    sourceEventId: null,
    dedupKey: `tpl-${t.to}:${id}:${site}:${t.at}`,
    once: { kinds: SIGNIN_KINDS },
    content: (): MessageContent => ({
      blocks: [
        {
          type: 'fields',
          items: [
            { label: 'Template', value: [link(t.template.display_name, templatePath(id))] },
            { label: 'Site', value: [code(site)] },
            ...(t.covers.length > 1
              ? [{ label: 'Covers', value: [text(t.covers.join(', '))] }]
              : []),
            ...(t.reason === null ? [] : [{ label: 'Reason', value: [code(t.reason)] }]),
            { label: 'Since', value: [time(t.at)] },
          ],
        },
      ],
      actions,
      entities: {
        ...entities(id, t.template.name, site),
        ...(session !== undefined && { session_id: session }),
      },
    }),
  };
}

/** `template.health` with every site of the provider signed in again: its sign-out resolves. */
export function signinRevision(payload: DomainEvents['template.health']): ThreadRevision | null {
  const t = payload.transition;
  if (t === undefined || t.to !== 'signed_in' || !t.provider_signed_in) return null;
  return {
    thread: providerThread(payload.template_id, t.provider),
    kinds: SIGNIN_KINDS,
    dedupKey: `tpl-in:${payload.template_id}:${t.provider}:${t.at}`,
    change: {
      state: 'resolved',
      summary: `Signed in again: ${providerText(t)}.`,
      fields: [{ label: 'Signed in', value: [time(t.at)] }],
    },
  };
}

/**
 * `template.removed`: every sign-out and challenge thread of the template goes `final` (spec 13
 * §8.6, D34); nothing can sign it in again.
 */
export function templateGoneRevision(payload: DomainEvents['template.removed']): ThreadRevision {
  return {
    thread: providerThread(payload.template_id, ''),
    prefix: { except: [] },
    kinds: SIGNIN_KINDS,
    dedupKey: `tpl-gone:${payload.template_id}`,
    change: { state: 'final', summary: 'The template was deleted.' },
  };
}

/**
 * `template.changed`: the sign-out and challenge threads of identity providers no site of the
 * template uses any more (the site was removed) go `final` (spec 13 §8.6, D34).
 */
export function sitesGoneRevision(
  payload: DomainEvents['template.changed'],
): ThreadRevision | null {
  const providers = payload.providers;
  if (providers === undefined) return null;
  const id = payload.template.template_id;
  return {
    thread: providerThread(id, ''),
    prefix: { except: providers.ids.map((p) => providerThread(id, p)) },
    kinds: SIGNIN_KINDS,
    dedupKey: `tpl-sites:${id}:${providers.at}`,
    change: { state: 'final', summary: 'The site is no longer part of this template.' },
  };
}

const RELOGIN_ERRORS: Readonly<Record<string, string>> = {
  timed_out: 'Nobody signed in within 30 minutes.',
  retry_window:
    'Signed out again within 24 hours of the last automatic re-login, so it was not tried again.',
  not_authorized: 'The vault binding does not allow this template.',
  still_signed_out: 'The vault fill ran, but the site still reads signed out.',
  window_closed: 'The sign-in window closed before the site was signed in.',
};

/** `template.relogin` ending failed or timed out: `template.relogin_failed` (final). */
export function reloginFailedDraft(
  payload: DomainEvents['template.relogin'],
): NotificationDraft | null {
  const r = payload.relogin;
  if (r.state !== 'failed' && r.state !== 'timed_out') return null;
  const id = payload.template_id;
  const display = payload.names?.display_name ?? id;
  const path = templatePath(id, r.site_id);
  const error = r.error ?? r.state;
  const how = r.method === 'vault' ? 'automatic re-login' : 're-login';
  const summary = RELOGIN_ERRORS[error] ?? `The ${how} failed (${error}).`;
  return {
    type: 'error',
    kind: 'template.relogin_failed',
    severity: KIND_SEVERITY['template.relogin_failed'],
    state: 'final',
    thread: providerThread(id, payload.provider ?? r.site_id),
    title: clip(
      `${display}: ${how} of ${r.site_id} ${r.state === 'timed_out' ? 'timed out' : 'failed'}`,
      TITLE_MAX,
    ),
    body: summary,
    sessionId: null,
    target: path,
    sourceEventId: null,
    dedupKey: `tpl-rf:${id}:${r.requested_at}`,
    content: () => ({
      blocks: [
        {
          type: 'fields',
          items: [
            { label: 'Template', value: [link(display, templatePath(id))] },
            { label: 'Site', value: [code(r.site_id)] },
            { label: 'Method', value: [text(r.method)] },
            { label: 'Reason', value: [code(error)] },
          ],
        },
      ],
      actions: [
        { kind: 'open', id: 'open-template', label: 'Open template', style: 'primary', path },
      ],
      entities: entities(id, payload.names?.name ?? id, r.site_id),
    }),
  };
}

/** `template.host` reaching `failed`: `template.host_failed`. */
export function hostFailedDraft(payload: DomainEvents['template.host']): NotificationDraft | null {
  const host = payload.host;
  if (host.state !== 'failed' || payload.previous_state === 'failed') return null;
  const id = payload.template_id;
  const display = payload.names?.display_name ?? id;
  const path = templatePath(id);
  const cause = host.last_error ?? 'unknown';
  return {
    type: 'error',
    kind: 'template.host_failed',
    severity: KIND_SEVERITY['template.host_failed'],
    state: 'open',
    thread: hostThread(id),
    title: clip(`${display}: browser failed`, TITLE_MAX),
    body: `The template's browser cannot start until an operator restarts it (${cause}). Launches are refused meanwhile.`,
    sessionId: null,
    target: path,
    sourceEventId: null,
    dedupKey: `tpl-hf:${id}:${host.since ?? 0}`,
    once: { kinds: ['template.host_failed'] },
    content: () => ({
      blocks: [
        {
          type: 'fields',
          items: [
            { label: 'Template', value: [link(display, path)] },
            { label: 'Cause', value: [code(cause)] },
            ...(host.since === null ? [] : [{ label: 'Since', value: [time(host.since)] }]),
          ],
        },
      ],
      actions: [
        { kind: 'open', id: 'open-template', label: 'Open template', style: 'primary', path },
      ],
      entities: entities(id, payload.names?.name ?? id),
    }),
  };
}

/** `template.host` running again after it failed: its notification resolves. */
export function hostRevision(payload: DomainEvents['template.host']): ThreadRevision | null {
  if (payload.host.state !== 'running' || payload.previous_state === 'running') return null;
  if (payload.previous_state === undefined) return null;
  return {
    thread: hostThread(payload.template_id),
    kinds: ['template.host_failed'],
    dedupKey: `tpl-hok:${payload.template_id}:${payload.host.since ?? 0}`,
    change: {
      state: 'resolved',
      summary: 'The browser runs again.',
      fields:
        payload.host.since === null
          ? []
          : [{ label: 'Running since', value: [time(payload.host.since)] }],
    },
  };
}
