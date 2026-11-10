/** @module features/templates/detail/settings-patch — PATCH bodies of the Settings tab: the whole policy with health changes (so access fields keep their values), and the browser and proxy fields with the identity-change confirmation flag */
import type { Template, TemplatePolicy } from '@browserhive/contracts/http';

/** The complete policy as submitted, with `patch` applied. */
export function policyWith(
  policy: TemplatePolicy,
  patch: Partial<Pick<TemplatePolicy, 'health_interval_ms' | 'prelaunch_check'>>,
): Readonly<Record<string, unknown>> {
  return {
    policy: {
      authorized_principals: [...policy.authorized_principals],
      harnesses: policy.harnesses === undefined ? null : [...policy.harnesses],
      max_concurrent: policy.max_concurrent,
      unseal: { ...policy.unseal },
      health_interval_ms: patch.health_interval_ms ?? policy.health_interval_ms,
      prelaunch_check: patch.prelaunch_check ?? policy.prelaunch_check,
    },
  };
}

/** The proxy form. */
export interface ProxyDraft {
  readonly server: string;
  readonly username: string;
  readonly password_env: string;
  readonly label: string;
}

/** The form of a stored proxy. */
export function proxyDraftOf(template: Pick<Template, 'proxy'>): ProxyDraft {
  return {
    server: template.proxy?.server ?? '',
    username: template.proxy?.username ?? '',
    password_env: template.proxy?.password_env ?? '',
    label: template.proxy?.label ?? '',
  };
}

/** What is wrong with a proxy form, or `null` (the server checks the rest). */
export function proxyProblem(draft: ProxyDraft): string | null {
  const server = draft.server.trim();
  if (server === '') return 'Enter the proxy as scheme://host:port.';
  if (!/^[a-z][a-z0-9+.-]*:\/\/[^/@\s]+:\d+\/?$/i.test(server))
    return 'Use scheme://host:port without a user name or password.';
  if (draft.password_env.startsWith('BROWSERHIVE_'))
    return 'BROWSERHIVE_ variables are reserved; pick another name.';
  if (draft.password_env !== '' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(draft.password_env))
    return 'The password is the name of an environment variable, like PROXY_PASSWORD.';
  return null;
}

/** `{proxy, confirm_identity_change}` from the form. */
export function proxyPatch(draft: ProxyDraft): Readonly<Record<string, unknown>> {
  return {
    proxy: {
      server: draft.server.trim(),
      ...(draft.username.trim() !== '' && { username: draft.username.trim() }),
      ...(draft.password_env.trim() !== '' && { password_env: draft.password_env.trim() }),
      ...(draft.label.trim() !== '' && { label: draft.label.trim() }),
    },
    confirm_identity_change: true,
  };
}

/** Health-check intervals offered (the stored value is always listed too). */
export const HEALTH_INTERVALS: readonly { readonly ms: number; readonly label: string }[] = [
  { ms: 1_800_000, label: 'Every 30 minutes' },
  { ms: 3_600_000, label: 'Every hour' },
  { ms: 21_600_000, label: 'Every 6 hours' },
  { ms: 43_200_000, label: 'Every 12 hours' },
  { ms: 86_400_000, label: 'Every day' },
  { ms: 604_800_000, label: 'Every week' },
];
