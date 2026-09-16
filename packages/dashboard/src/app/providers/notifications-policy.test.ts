/** @module app/providers/notifications-policy.test — toast policy: no tool-error toasts by default, never for the session on screen, titles name the session; bell badge cap */
import { describe, expect, it } from 'bun:test';
import { notification } from '../../../test/fixtures/ops.ts';
import { bellBadge } from '../shell/NotificationBell.tsx';
import { DEFAULT_TOAST_TYPES, planToast } from './NotificationsProvider.tsx';

const SESSION = 'login-smoke-abcd1234' as never;

describe('toast policy', () => {
  it('keeps tool errors in the bell by default and toasts attention', () => {
    expect(DEFAULT_TOAST_TYPES).not.toContain('error');
    const error = notification(1, { type: 'error', title: 'login-smoke · 3 tool errors' });
    expect(planToast(error, { pathname: '/overview', preferences: undefined })).toBeNull();
    const attention = notification(2, {
      type: 'attention',
      title: 'Attention requested',
      session_id: SESSION,
      session_slug: 'login-smoke',
    });
    const plan = planToast(attention, { pathname: '/overview', preferences: undefined });
    expect(plan).toMatchObject({
      tone: 'warning',
      title: 'login-smoke · Attention requested',
      persist: true,
      target: `/sessions/${SESSION}`,
    });
  });

  it('honours an explicit opt-in, but never toasts errors for the session on screen', () => {
    const error = notification(3, {
      type: 'error',
      title: 'login-smoke · 2 tool errors',
      session_id: SESSION,
      session_slug: 'login-smoke',
      target: `/sessions/${SESSION}?kinds=tool&errors_only=1`,
    });
    const prefs = { types: ['error' as const] };
    // The grouped title already names the session: no double prefix.
    expect(planToast(error, { pathname: '/overview', preferences: prefs })?.title).toBe(
      'login-smoke · 2 tool errors',
    );
    expect(planToast(error, { pathname: `/sessions/${SESSION}`, preferences: prefs })).toBeNull();
    expect(planToast(error, { pathname: '/overview', preferences: { toasts: false } })).toBeNull();
  });

  it('caps the bell badge at 9+', () => {
    expect(bellBadge(3)).toBe('3');
    expect(bellBadge(9)).toBe('9');
    expect(bellBadge(10)).toBe('9+');
    expect(bellBadge(250)).toBe('9+');
  });
});
