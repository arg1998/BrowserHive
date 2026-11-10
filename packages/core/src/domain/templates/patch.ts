/** @module domain/templates/patch — validating an operator's edit of a template (spec 13 §2.2, §11.1 `PATCH /templates/{id}`): the frozen identity stays, `proxy` and `channel` need `confirm_identity_change`, policy fields merge one by one, and which changes restart the browser or must reach live sessions. */

import type { TemplatePatchInput } from '@browserhive/contracts/http';
import type { TemplatePatch, TemplateRecord } from '../../ports/persistence/index.ts';
import { isReservedSubject } from '../auth/reserved-subjects.ts';
import { LOCAL_SUBJECT } from '../session/principal.ts';
import { type TemplateInputIssue, validateProxy } from './create.ts';

/** A validated edit. */
export interface ValidatedPatch {
  readonly patch: TemplatePatch;
  /** Changed field names for the audit row (`unseal` and `access` named explicitly). */
  readonly changed: readonly string[];
  /** Channel, proxy or headless changed: the running browser restarts (spec 13 §3.2 recycle). */
  readonly restart: boolean;
  /** Access, harnesses or unseal changed: live sessions are re-checked (spec 13 §3.2). */
  readonly sessionsAffected: boolean;
}

function sameList(a: readonly string[] | null, b: readonly string[] | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function sameProxy(a: TemplateRecord['proxy'], b: TemplateRecord['proxy']): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Validates `input` against `current` and builds the repository patch. Fields equal to the stored
 * value are not changes.
 */
export function validateTemplatePatch(
  input: TemplatePatchInput,
  current: TemplateRecord,
  now: number,
):
  | { readonly ok: true; readonly value: ValidatedPatch }
  | { readonly ok: false; readonly issues: readonly TemplateInputIssue[] } {
  const issues: TemplateInputIssue[] = [];
  const patch: { -readonly [K in keyof TemplatePatch]: TemplatePatch[K] } = {};
  const changed: string[] = [];
  const set = <K extends keyof TemplatePatch>(key: K, value: TemplatePatch[K], label: string) => {
    if (JSON.stringify(value) === JSON.stringify(current[key as keyof TemplateRecord])) return;
    patch[key] = value;
    changed.push(label);
  };
  if (input.name !== undefined) set('name', input.name, 'name');
  if (input.display_name !== undefined) set('displayName', input.display_name, 'display_name');
  if (input.description !== undefined) set('description', input.description, 'description');
  if (input.agent_windows !== undefined) set('agentWindows', input.agent_windows, 'agent_windows');
  if (input.headless !== undefined) set('headless', input.headless, 'headless');
  if (input.humanize !== undefined) {
    // Collapses to false with stealth off, as at creation.
    set('humanize', current.stealth !== 'off' && input.humanize, 'humanize');
  }
  if (input.channel !== undefined) set('channel', input.channel, 'channel');
  if (input.proxy !== undefined) {
    const proxy = input.proxy === null ? null : validateProxy(input.proxy, issues);
    if (input.proxy === null || proxy !== null) {
      if (!sameProxy(proxy, current.proxy)) {
        patch.proxy = proxy;
        changed.push('proxy');
      }
    }
  }
  const identityChange = changed.includes('channel') || changed.includes('proxy');
  if (identityChange && input.confirm_identity_change !== true) {
    issues.push({
      path: 'confirm_identity_change',
      message:
        'changing the proxy or channel restarts the browser and sites may sign the account out; confirm with confirm_identity_change: true',
      code: 'confirm_required',
    });
  }
  const policy = input.policy;
  if (policy !== undefined) {
    const lists = [
      ['policy.authorized_principals', policy.authorized_principals ?? []],
      ['policy.unseal.principals', policy.unseal?.principals ?? []],
    ] as const;
    for (const [path, list] of lists) {
      list.forEach((subject, index) => {
        if (subject !== LOCAL_SUBJECT && isReservedSubject(subject)) {
          issues.push({
            path: `${path}.${index}`,
            message: `'${subject}' is a reserved subject: no agent can be it`,
            code: 'reserved',
          });
        }
      });
    }
    if (policy.authorized_principals !== undefined) {
      const next = [...new Set(policy.authorized_principals)];
      if (!sameList(next, current.authorizedPrincipals)) {
        patch.authorizedPrincipals = next;
        changed.push('access');
      }
    }
    if (policy.harnesses !== undefined) {
      const next = policy.harnesses === null ? null : [...new Set(policy.harnesses)];
      if (!sameList(next, current.harnesses)) {
        patch.harnesses = next;
        changed.push('harnesses');
      }
    }
    if (policy.unseal !== undefined) {
      const u = policy.unseal;
      const unseal = {
        cookieValues: u.cookie_values,
        evaluate: u.evaluate,
        cookieWrites: u.cookie_writes,
        stateExport: u.state_export,
        principals:
          u.principals === undefined || u.principals.length === 0
            ? null
            : [...new Set(u.principals)],
      };
      if (JSON.stringify(unseal) !== JSON.stringify(current.unseal)) {
        patch.unseal = unseal;
        changed.push('unseal');
      }
    }
    if (policy.max_concurrent !== undefined) {
      set('maxConcurrent', policy.max_concurrent, 'max_concurrent');
    }
    if (policy.health_interval_ms !== undefined) {
      set('healthIntervalMs', policy.health_interval_ms, 'health_interval_ms');
    }
    if (policy.prelaunch_check !== undefined) {
      set('prelaunchCheck', policy.prelaunch_check, 'prelaunch_check');
    }
  }
  if (issues.length > 0) return { ok: false, issues };
  if (changed.length > 0) patch.updatedAt = now;
  return {
    ok: true,
    value: {
      patch,
      changed,
      restart: identityChange || changed.includes('headless'),
      sessionsAffected: ['access', 'harnesses', 'unseal'].some((c) => changed.includes(c)),
    },
  };
}
