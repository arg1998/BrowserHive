/** @module features/templates/wizard/draft — the new-template wizard's draft (spec 13 §7.1 steps 1–4): its shape, per-step problems, the `POST /templates` body, server field issues mapped back to their step, and the copy kept in this tab's `sessionStorage` (it survives a reload; closing the tab, Cancel, signing out or a 401 forgets it, and an older build's `localStorage` copy is dropped on read) */
import type { Channel, StealthLevel } from '@browserhive/contracts/enums';
import type { TemplateInput } from '@browserhive/contracts/http';
import { readStorageJson, removeStorage, writeStorageJson } from '@/lib/storage.ts';
import { hostOf, nameProblem } from '../model.ts';
import type { WizardStep } from '../search.ts';
import { UNSEAL_FLAGS, type UnsealFlag } from '../unseal.ts';
import { FIELD_OF_ISSUE_CODE } from './site-needs.ts';

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
  /**
   * Site → the SHA-256 of the site pack version shown when it was added (spec 13 §9.6 "First use");
   * creating the template approves exactly that version. Sites without an entry are generic.
   */
  readonly packs: Readonly<Record<string, string>>;
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
  packs: {},
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

/** Where the draft lives in this tab's `sessionStorage` (`bh.templateDraft`; earlier builds used `localStorage`). */
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

/**
 * Add a site as typed; returns the new draft and what went wrong, if anything. `packSha256`: the
 * site pack version the operator was shown for it (approved when the template is created).
 */
export function addSite(
  draft: TemplateDraft,
  input: string,
  packSha256?: string,
): { readonly draft: TemplateDraft; readonly error: string | null } {
  const host = hostOf(input);
  if (host === null) return { draft, error: 'Enter a domain like linkedin.com.' };
  if (draft.sites.includes(host)) return { draft, error: `${host} is already in the list.` };
  if (draft.sites.length >= SITES_MAX) return { draft, error: `At most ${SITES_MAX} sites.` };
  return {
    draft: {
      ...draft,
      sites: [...draft.sites, host],
      ...(packSha256 !== undefined && { packs: { ...draft.packs, [host]: packSha256 } }),
    },
    error: null,
  };
}

/** Remove a site and the pack version chosen for it. */
export function removeSite(draft: TemplateDraft, site: string): TemplateDraft {
  const { [site]: _dropped, ...packs } = draft.packs;
  return { ...draft, sites: draft.sites.filter((s) => s !== site), packs };
}

/**
 * The `POST /templates` body. `catalogShas`: site → the SHA-256 the catalog offers for it now; a site
 * added before the catalog loaded (or restored from an older draft) still sends the version its
 * card shows (review S-M4). A hash chosen when the site was added wins.
 */
export function toTemplateInput(
  draft: TemplateDraft,
  catalogShas: Readonly<Record<string, string>> = {},
): TemplateInput {
  const trim = (s: string) => s.trim();
  const proxy = draft.proxy;
  const unsealOn = UNSEAL_FLAGS.some((f) => draft.unseal[f]);
  return {
    name: draft.name,
    ...(trim(draft.displayName).length > 0 && { display_name: trim(draft.displayName) }),
    ...(draft.description.trim().length > 0 && { description: draft.description.trim() }),
    sites: draft.sites.map((site_id) => {
      const sha = draft.packs[site_id] ?? catalogShas[site_id];
      return sha === undefined ? { site_id } : { site_id, pack_sha256: sha };
    }),
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

/**
 * Field issues of a `VALIDATION_FAILED` answer. A site pack's requirement (`sites[i]` with a code
 * such as `stealth_below_floor`) belongs to the step 3 setting that meets it.
 */
export function issuesOf(details: Readonly<Record<string, unknown>>): DraftProblem[] {
  const issues = details['issues'];
  if (!Array.isArray(issues)) return [];
  return issues.flatMap((issue: unknown) => {
    if (typeof issue !== 'object' || issue === null) return [];
    const { path, message, code } = issue as { path?: unknown; message?: unknown; code?: unknown };
    const setting = typeof code === 'string' ? FIELD_OF_ISSUE_CODE[code] : undefined;
    return typeof path === 'string' && typeof message === 'string'
      ? [{ field: setting ?? path.replace(/^body\./, ''), message }]
      : [];
  });
}

function validDraft(raw: unknown): TemplateDraft | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const merged = { ...EMPTY_DRAFT, ...(raw as Partial<TemplateDraft>) };
  const packs =
    typeof merged.packs === 'object' && merged.packs !== null && !Array.isArray(merged.packs)
      ? Object.fromEntries(
          Object.entries(merged.packs).filter(
            (entry): entry is [string, string] =>
              typeof entry[1] === 'string' && /^[0-9a-f]{64}$/.test(entry[1]),
          ),
        )
      : {};
  return typeof merged.name === 'string' && Array.isArray(merged.sites)
    ? { ...merged, packs }
    : null;
}

/** `true` when the operator entered anything (Cancel then asks before discarding it). */
export function draftHasContent(draft: TemplateDraft): boolean {
  const { nameTouched: _a, ...rest } = draft;
  const { nameTouched: _b, ...empty } = EMPTY_DRAFT;
  return JSON.stringify(rest) !== JSON.stringify(empty);
}

/** The draft kept in this tab, if any. An older build's copy in `localStorage` is dropped, never read. */
export function readDraft(): TemplateDraft | null {
  removeStorage(DRAFT_KEY);
  return readStorageJson(DRAFT_KEY, validDraft, 'session');
}

/** Keep the draft in this tab (a reload keeps it; closing the tab does not). */
export function writeDraft(draft: TemplateDraft): void {
  writeStorageJson(DRAFT_KEY, draft, 'session');
}

/** Forget the draft (after the template is created, or on Cancel), wherever a build kept it. */
export function clearDraft(): void {
  removeStorage(DRAFT_KEY, 'session');
  removeStorage(DRAFT_KEY);
}

/** The templates this tab's wizard created (`bh.templatesCreated`, this tab only; sign-out clears it). */
export const CREATED_KEY = 'bh.templatesCreated';

function createdIds(): string[] {
  return (
    readStorageJson(
      CREATED_KEY,
      (raw) => (Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : null),
      'session',
    ) ?? []
  );
}

/** Remember that this tab's wizard created `templateId` (only such a template offers Cancel setup). */
export function markCreatedHere(templateId: string): void {
  writeStorageJson(
    CREATED_KEY,
    [...createdIds().filter((id) => id !== templateId), templateId].slice(-20),
    'session',
  );
}

/** True when this tab's wizard created `templateId`. */
export function createdHere(templateId: string): boolean {
  return createdIds().includes(templateId);
}

/** Forget a template this tab created (it was finished or deleted). */
export function forgetCreated(templateId: string): void {
  writeStorageJson(
    CREATED_KEY,
    createdIds().filter((id) => id !== templateId),
    'session',
  );
}
