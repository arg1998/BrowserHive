/** @module features/vault/tester/decide — pure shaping of the server dry-run (`POST /vault/bindings/resolve`) into per-binding decisions with a gate-by-gate reason chain */
import type {
  ResolveBindingsResponse,
  VaultBinding,
  VaultGroup,
} from '@browserhive/contracts/http';

/** Outcome of one gate. */
export type GateOutcome = 'pass' | 'fail' | 'skipped';

/** One step of the reason chain. */
export interface Gate {
  readonly gate: 'group policy' | 'session authorized' | 'origin allow-list' | 'fill gates';
  readonly outcome: GateOutcome;
  readonly detail: string;
}

/** Decision for one binding. */
export interface TesterDecision {
  readonly handle: string;
  readonly decision: 'fill' | 'blocked';
  readonly reason: string | null;
  readonly chain: readonly Gate[];
}

/** Operator-facing text per broker reason code. */
export const REASON_TEXT: Readonly<Record<string, string>> = {
  not_authorized: 'the session or principal is not authorized for this binding',
  origin_mismatch: 'the page origin is not in the allow-list',
  list_url_mismatch: 'the page URL does not match the item’s saved URLs',
  form_action_mismatch: 'the form posts to a different origin',
  evaluate_required_off: 'evaluate must be disabled for this session',
  vault_locked: 'the backend is locked',
  vault_disabled: 'the vault is disabled for this session',
  dashboard_denied: 'an operator denied the fill',
};

/** Normalise tester input to an absolute URL (`app.example.com` → `https://app.example.com/`); `null` when unusable. */
export function normalizeTesterUrl(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === '') return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(withScheme).toString();
  } catch {
    return null;
  }
}

/** Build the decision list, optionally narrowed to handles/items containing `entry`. Fills first, then blocked, by handle. */
export function testerDecisions(
  result: ResolveBindingsResponse,
  context: {
    readonly bindings: readonly VaultBinding[];
    readonly groups: readonly VaultGroup[];
    readonly slug?: string | undefined;
    readonly entry?: string | undefined;
  },
): TesterDecision[] {
  const byHandle = new Map(context.bindings.map((b) => [b.handle, b]));
  const policyOf = (handle: string) => {
    const groupId = byHandle.get(handle)?.group_id;
    return (
      context.groups.find((g) => g.group_id === (groupId ?? null))?.policy?.access_mode ?? null
    );
  };
  const slugGate = (outcome: GateOutcome): Gate => ({
    gate: 'session authorized',
    outcome:
      context.slug === undefined || context.slug === ''
        ? outcome === 'fail'
          ? 'fail'
          : 'skipped'
        : outcome,
    detail:
      context.slug === undefined || context.slug === ''
        ? 'no session slug given'
        : `slug ${context.slug}`,
  });
  const decisions: TesterDecision[] = [
    ...result.would_fill.map((handle) => ({
      handle,
      decision: 'fill' as const,
      reason: null,
      chain: [
        {
          gate: 'group policy' as const,
          outcome: 'pass' as const,
          detail: policyOf(handle) ?? 'no group policy',
        },
        slugGate('pass'),
        { gate: 'origin allow-list' as const, outcome: 'pass' as const, detail: 'origin allowed' },
        { gate: 'fill gates' as const, outcome: 'pass' as const, detail: 'would fill' },
      ],
    })),
    ...result.blocked.map(({ handle, reason }) => {
      const rejectAll = reason === 'not_authorized' && policyOf(handle) === 'reject_all';
      const chain: Gate[] = rejectAll
        ? [
            { gate: 'group policy', outcome: 'fail', detail: 'reject_all' },
            slugGate('skipped'),
            { gate: 'origin allow-list', outcome: 'skipped', detail: '—' },
            { gate: 'fill gates', outcome: 'skipped', detail: '—' },
          ]
        : reason === 'not_authorized'
          ? [
              {
                gate: 'group policy',
                outcome: 'pass',
                detail: policyOf(handle) ?? 'no group policy',
              },
              slugGate('fail'),
              { gate: 'origin allow-list', outcome: 'skipped', detail: '—' },
              { gate: 'fill gates', outcome: 'skipped', detail: '—' },
            ]
          : reason === 'origin_mismatch'
            ? [
                {
                  gate: 'group policy',
                  outcome: 'pass',
                  detail: policyOf(handle) ?? 'no group policy',
                },
                slugGate('pass'),
                {
                  gate: 'origin allow-list',
                  outcome: 'fail',
                  detail: REASON_TEXT['origin_mismatch'] ?? reason,
                },
                { gate: 'fill gates', outcome: 'skipped', detail: '—' },
              ]
            : [
                {
                  gate: 'group policy',
                  outcome: 'pass',
                  detail: policyOf(handle) ?? 'no group policy',
                },
                slugGate('pass'),
                { gate: 'origin allow-list', outcome: 'pass', detail: 'origin allowed' },
                { gate: 'fill gates', outcome: 'fail', detail: REASON_TEXT[reason] ?? reason },
              ];
      return { handle, decision: 'blocked' as const, reason, chain };
    }),
  ];
  const needle = context.entry?.trim().toLowerCase() ?? '';
  return decisions
    .filter(
      (d) =>
        needle === '' ||
        d.handle.includes(needle) ||
        (byHandle.get(d.handle)?.item_name.toLowerCase().includes(needle) ?? false),
    )
    .sort((a, b) =>
      a.decision === b.decision ? a.handle.localeCompare(b.handle) : a.decision === 'fill' ? -1 : 1,
    );
}
