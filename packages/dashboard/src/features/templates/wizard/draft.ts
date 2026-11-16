/** @module features/templates/wizard/draft — the new-template wizard's draft (spec 13 §7.1 steps 1–4): its shape, per-step problems, the `POST /templates` body, server field issues mapped back to their step, and the per-device copy in `localStorage` that survives a reload */
import type { Channel, StealthLevel } from '@browserhive/contracts/enums';
import type { TemplateInput } from '@browserhive/contracts/http';
import { readStorageJson, removeStorage, writeStorageJson } from '@/lib/storage.ts';
import { hostOf, nameProblem } from '../model.ts';
import type { WizardStep } from '../search.ts';
import { UNSEAL_FLAGS, type UnsealFlag } from '../unseal.ts';

/** Who may use the template: every agent, or the listed principals; `null` = not chosen yet. */
export type AccessChoice = 'all' | 'listed' | null;

/** The wizard's draft. Empty strings and `null` mean "the server's default". */
export interface TemplateDraft {
  readonly name: string;
  /** `true` once the operator typed a name (stop suggesting one from the display name). */
  readonly nameTouched: boolean;
  readonly displayName: string;
  readonly description: string;
  readonly sites: readonly string[];
  readonly channel: Channel | null;
  readonly stealth: StealthLevel | null;
  readonly fingerprint: boolean | null;
  readonly headless: boolean;
  readonly useProxy: boolean;
  readonly proxy: {
    readonly server: string;
    readonly username: string;
    readonly passwordEnv: string;
    readonly label: string;
    readonly bypass: string;
  };
  readonly locale: string;
  readonly timezoneId: string;
  readonly agentWindows: 'normal' | 'minimized';
  readonly access: AccessChoice;
  readonly principals: readonly string[];
  readonly harnesses: readonly string[] | null;
  readonly maxConcurrent: number;
  readonly unseal: { readonly [F in UnsealFlag]: boolean };
  readonly unsealPrincipals: readonly string[];
}

/** A fresh draft. */
export const EMPTY_DRAFT: TemplateDraft = {
  name: '',
  nameTouched: false,
  displayName: '',
  description: '',
  sites: [],
  channel: null,
  stealth: null,
  fingerprint: null,
  headless: false,
  useProxy: false,
  proxy: { server: '', username: '', passwordEnv: '', label: '', bypass: '' },
  locale: '',
  timezoneId: '',
  agentWindows: 'normal',
  access: null,
  principals: [],
  harnesses: null,
  maxConcurrent: 5,
  unseal: { cookie_values: false, evaluate: false, cookie_writes: false, state_export: false },
  unsealPrincipals: [],
};

/** One problem: the field it belongs to and what to do. */
export interface DraftProblem {
  readonly field: string;
  readonly message: string;
}

/** Where the draft lives on this device (`bh.templateDraft`). */
export const DRAFT_KEY = 'bh.templateDraft';

/** At most this many sites (spec 13 §2.1). */
export const SITES_MAX = 16;

const LOCALE_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const PROXY_RE = /^(https?|socks5?):\/\/[^\s/@]+(:\d{1,5})?\/?$/i;
const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** Problems of one step (empty = the step may be left). `authToken`: the server runs `auth=token`. */
export function stepProblems(
  draft: TemplateDraft,
  step: WizardStep,
  authToken: boolean,
): DraftProblem[] {
  const out: DraftProblem[] = [];
  if (step === 1) {
    const name = nameProblem(draft.name);
    if (name !== null) out.push({ field: 'name', message: name });
    if (draft.displayName.trim().length > 80)
      out.push({ field: 'displayName', message: 'At most 80 characters.' });
    if (draft.description.length > 500)
      out.push({ field: 'description', message: 'At most 500 characters.' });
  }
  if (step === 2) {
    if (draft.sites.length === 0) out.push({ field: 'sites', message: 'Add at least one site.' });
    if (draft.sites.length > SITES_MAX)
      out.push({ field: 'sites', message: `At most ${SITES_MAX} sites.` });
  }
  if (step === 3) {
    if (draft.useProxy) {
      const server = draft.proxy.server.trim();
      if (server.length === 0)
        out.push({ field: 'proxy.server', message: 'Enter the proxy address.' });
      else if (server.includes('@'))
        out.push({
          field: 'proxy.server',
          message: 'Leave the user name and password out of the address; use the fields below.',
        });
      else if (!PROXY_RE.test(server))
        out.push({
          field: 'proxy.server',
          message: 'Use scheme://host:port, like http://10.0.0.5:3128.',
        });
      const env = draft.proxy.passwordEnv.trim();
      if (env.length > 0 && !ENV_RE.test(env))
        out.push({ field: 'proxy.passwordEnv', message: 'Letters, digits and _ only.' });
      else if (env.toUpperCase().startsWith('BROWSERHIVE_'))
        out.push({
          field: 'proxy.passwordEnv',
          message: 'BROWSERHIVE_ variables are BrowserHive’s own; choose another name.',
        });
      if (draft.locale.trim().length === 0)
        out.push({ field: 'locale', message: 'With a proxy, set the language explicitly.' });
      if (draft.timezoneId.trim().length === 0)
        out.push({ field: 'timezoneId', message: 'With a proxy, set the time zone explicitly.' });
    }
    if (draft.locale.trim().length > 0 && !LOCALE_RE.test(draft.locale.trim()))
      out.push({ field: 'locale', message: 'A language tag like en-CA.' });
  }
  if (step === 4) {
    if (authToken && draft.access === null)
      out.push({ field: 'access', message: 'Choose who may use this template.' });
    if (draft.access === 'listed' && draft.principals.length === 0)
      out.push({ field: 'principals', message: 'Add at least one agent, or choose All agents.' });
    if (
      !Number.isInteger(draft.maxConcurrent) ||
      draft.maxConcurrent < 1 ||
      draft.maxConcurrent > 20
    )
      out.push({ field: 'maxConcurrent', message: 'A number from 1 to 20.' });
  }
  return out;
}

/** Problems of steps 1–4 together. */
export function draftProblems(draft: TemplateDraft, authToken: boolean): DraftProblem[] {
  return ([1, 2, 3, 4] as const).flatMap((step) => stepProblems(draft, step, authToken));
}

/** The first step with a problem, or `null`. */
export function firstProblemStep(draft: TemplateDraft, authToken: boolean): WizardStep | null {
  for (const step of [1, 2, 3, 4] as const) {
    if (stepProblems(draft, step, authToken).length > 0) return step;
  }
  return null;
}

/** Add a site as typed; returns the new draft and what went wrong, if anything. */
export function addSite(
  draft: TemplateDraft,
  input: string,
): { readonly draft: TemplateDraft; readonly error: string | null } {
  const host = hostOf(input);
  if (host === null) return { draft, error: 'Enter a domain like linkedin.com.' };
  if (draft.sites.includes(host)) return { draft, error: `${host} is already in the list.` };
  if (draft.sites.length >= SITES_MAX) return { draft, error: `At most ${SITES_MAX} sites.` };
  return { draft: { ...draft, sites: [...draft.sites, host] }, error: null };
}

/** The `POST /templates` body. */
export function toTemplateInput(draft: TemplateDraft): TemplateInput {
  const trim = (s: string) => s.trim();
  const proxy = draft.proxy;
  const unsealOn = UNSEAL_FLAGS.some((f) => draft.unseal[f]);
  return {
    name: draft.name,
    ...(trim(draft.displayName).length > 0 && { display_name: trim(draft.displayName) }),
    ...(draft.description.trim().length > 0 && { description: draft.description.trim() }),
    sites: draft.sites.map((site_id) => ({ site_id })),
    ...(draft.channel !== null && { channel: draft.channel }),
    ...(draft.stealth !== null && { stealth: draft.stealth }),
    ...(draft.fingerprint !== null && { fingerprint: draft.fingerprint }),
    ...(draft.headless && { headless: true }),
    ...(draft.useProxy && {
      proxy: {
        server: trim(proxy.server),
        ...(trim(proxy.username).length > 0 && { username: trim(proxy.username) }),
        ...(trim(proxy.passwordEnv).length > 0 && { password_env: trim(proxy.passwordEnv) }),
        ...(trim(proxy.label).length > 0 && { label: trim(proxy.label) }),
        ...(trim(proxy.bypass).length > 0 && { bypass: trim(proxy.bypass) }),
      },
    }),
    ...(trim(draft.locale).length > 0 && { locale: trim(draft.locale) }),
    ...(trim(draft.timezoneId).length > 0 && { timezone_id: trim(draft.timezoneId) }),
    ...(draft.agentWindows !== 'normal' && { agent_windows: draft.agentWindows }),
    policy: {
      ...(draft.access === 'all' && { authorized_principals: [] }),
      ...(draft.access === 'listed' && { authorized_principals: [...draft.principals] }),
      ...(draft.harnesses !== null && { harnesses: [...draft.harnesses] }),
      max_concurrent: draft.maxConcurrent,
      ...(unsealOn && {
        unseal: {
          ...draft.unseal,
          ...(draft.unsealPrincipals.length > 0 && { principals: [...draft.unsealPrincipals] }),
        },
      }),
    },
  };
}

/** The step a server field issue belongs to (`body.sites.0.site_id` → 2). */
export function stepOfIssue(path: string): WizardStep {
  const field = path.replace(/^body\./, '').split('.')[0] ?? '';
  if (['name', 'display_name', 'description'].includes(field)) return 1;
  if (field === 'sites') return 2;
  if (field === 'policy') return 4;
  return 3;
}

/** Field issues of a `VALIDATION_FAILED` answer. */
export function issuesOf(details: Readonly<Record<string, unknown>>): DraftProblem[] {
  const issues = details['issues'];
  if (!Array.isArray(issues)) return [];
  return issues.flatMap((issue: unknown) => {
    if (typeof issue !== 'object' || issue === null) return [];
    const { path, message } = issue as { path?: unknown; message?: unknown };
    return typeof path === 'string' && typeof message === 'string'
      ? [{ field: path.replace(/^body\./, ''), message }]
      : [];
  });
}

function validDraft(raw: unknown): TemplateDraft | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const merged = { ...EMPTY_DRAFT, ...(raw as Partial<TemplateDraft>) };
  return typeof merged.name === 'string' && Array.isArray(merged.sites) ? merged : null;
}

/** The draft saved on this device, if any. */
export function readDraft(): TemplateDraft | null {
  return readStorageJson(DRAFT_KEY, validDraft);
}

/** Keep the draft on this device. */
export function writeDraft(draft: TemplateDraft): void {
  writeStorageJson(DRAFT_KEY, draft);
}

/** Forget the draft (after the template is created, or on Start over). */
export function clearDraft(): void {
  removeStorage(DRAFT_KEY);
}
