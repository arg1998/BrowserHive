/** @module app/templates/relogin-link — linking a vault binding to a template site for auto-relogin (spec 13 §8.4, §11.1 `PUT …/sites/{site_id}/relogin`): the link, the auto-relogin switch and form, **Allow this template**, and which gates of the binding would refuse the template. */

import type { BindingProblem, PutReloginLinkResponse } from '@browserhive/contracts/http';
import { AppError } from '../../kernel/errors/app-error.ts';
import { registrableDomain } from '../../kernel/url.ts';
import type { Clock } from '../../ports/clock.ts';
import type { EventPublisher } from '../../ports/event-bus.ts';
import type { IdGenerator } from '../../ports/id-generator.ts';
import type {
  Repositories,
  TemplateSiteFormRecord,
  TemplateSiteRecord,
  VaultBindingRecord,
} from '../../ports/persistence/index.ts';
import type { DomainEvents } from '../events/catalog.ts';
import type { VaultAdmin } from '../vault/vault-admin.ts';
import { templatePrincipal } from './relogin-vault.ts';
import { notFoundForOperator, validationFailed } from './template-errors.ts';
import type { TemplatePacks } from './template-packs.ts';
import { toSiteView } from './views.ts';

/** The request, camelCase. */
export interface ReloginLinkInput {
  readonly vaultHandle: string | null;
  readonly autoRelogin?: boolean;
  readonly form?: TemplateSiteFormRecord | null;
  readonly allowTemplate: boolean;
}

/** Collaborators of {@link ReloginLinks}. */
export interface ReloginLinksDeps {
  readonly repos: Pick<Repositories, 'templates' | 'templateSites' | 'operatorActions'>;
  /** Absent under `vault=off`. */
  readonly admin?: Pick<VaultAdmin, 'getBinding' | 'putBinding'>;
  readonly ids: Pick<IdGenerator, 'eventId'>;
  readonly clock: Clock;
  readonly bus?: EventPublisher<DomainEvents>;
  readonly changed?: (templateId: string) => void;
  /** Site packs (T3a): a `human_only` pack site refuses auto-relogin. */
  readonly packs?: TemplatePacks;
}

/** The gates a binding would refuse a template fill at (those checkable without a page). */
export function bindingProblems(
  binding: VaultBindingRecord | null,
  templateId: string,
): BindingProblem[] {
  if (binding === null) return ['binding_not_found'];
  const problems: BindingProblem[] = [];
  const principal = templatePrincipal(templateId);
  if (binding.authorizedPrincipals.length === 0) problems.push('principals_open');
  else if (!binding.authorizedPrincipals.includes(principal)) problems.push('principal_not_listed');
  if (binding.harnesses !== null) problems.push('harness_list');
  return problems;
}

/** Links of template sites to vault bindings. */
export class ReloginLinks {
  readonly #deps: ReloginLinksDeps;

  constructor(deps: ReloginLinksDeps) {
    this.#deps = deps;
  }

  /**
   * `PUT /templates/{template_id}/sites/{site_id}/relogin` (scopes checked by the route).
   *
   * `vault_handle: null` unlinks and turns auto-relogin off.
   *
   * @throws AppError `TEMPLATE_NOT_FOUND`, `VAULT_NOT_CONFIGURED`, `VALIDATION_FAILED`
   *   (`auto_relogin` without a form, an unknown binding, **Allow this template** on a binding open
   *   to every principal), `CONFLICT` (the binding changed meanwhile).
   */
  async put(
    templateId: string,
    rawSite: string,
    input: ReloginLinkInput,
    by: string,
  ): Promise<PutReloginLinkResponse> {
    const template = await this.#deps.repos.templates.get(templateId);
    if (template === null) throw notFoundForOperator(templateId);
    const sites = await this.#deps.repos.templateSites.list(templateId);
    const id = registrableDomain(rawSite) || rawSite;
    const site = sites.find((s) => s.siteId === id);
    if (site === undefined) throw notFoundForOperator(templateId);
    const admin = this.#deps.admin;
    if (admin === undefined) throw new AppError('VAULT_NOT_CONFIGURED', {});
    const form = input.form === undefined ? site.form : input.form;
    const handle = input.vaultHandle;
    const auto = handle === null ? false : (input.autoRelogin ?? site.autoRelogin);
    if (auto && this.#deps.packs?.humanOnly(site.packId) === true) {
      throw invalid(
        'auto_relogin',
        `${site.siteId} is signed in by a person only (its site pack is human_only)`,
      );
    }
    if (auto && form === null) {
      throw invalid('auto_relogin', `${site.siteId} needs sign-in form selectors for auto-relogin`);
    }
    let binding = handle === null ? null : await this.#binding(admin, handle);
    if (handle !== null && binding === null)
      throw invalid('vault_handle', `no vault binding '${handle}'`);
    if (input.allowTemplate && binding !== null)
      binding = await this.#allow(admin, binding, templateId);
    const updated: TemplateSiteRecord = {
      ...site,
      vaultHandle: handle,
      autoRelogin: auto,
      form,
      vaultLinkedBy:
        handle === null ? null : handle === site.vaultHandle ? (site.vaultLinkedBy ?? by) : by,
    };
    await this.#deps.repos.templateSites.upsert(updated);
    await this.#deps.repos.operatorActions.append({
      eventId: this.#deps.ids.eventId(),
      principalId: by,
      action: 'template.relogin_link',
      resourceKind: 'template',
      resourceId: templateId,
      details: {
        site_id: site.siteId,
        vault_handle: handle,
        auto_relogin: auto,
        allow_template: input.allowTemplate,
      },
      occurredAt: this.#deps.clock.now(),
    });
    const view = toSiteView(updated, this.#deps.packs, template);
    this.#deps.bus?.publish('template.health', {
      type: 'template.health',
      template_id: templateId,
      site: view,
    });
    this.#deps.changed?.(templateId);
    const problems = handle === null ? [] : bindingProblems(binding, templateId);
    return {
      site: view,
      binding_allows_template: handle !== null && problems.length === 0,
      binding_problems: problems,
    };
  }

  async #binding(
    admin: Pick<VaultAdmin, 'getBinding'>,
    handle: string,
  ): Promise<VaultBindingRecord | null> {
    try {
      return await admin.getBinding(handle);
    } catch {
      return null;
    }
  }

  /**
   * **Allow this template**: adds `template:<id>` to the binding's principals, nothing else (its
   * session rule is satisfied by the template's own maintenance sessions, review #81 M-1). A binding
   * open to every principal is refused: adding one principal would close it to everyone else.
   */
  async #allow(
    admin: Pick<VaultAdmin, 'putBinding'>,
    binding: VaultBindingRecord,
    templateId: string,
  ): Promise<VaultBindingRecord> {
    const principal = templatePrincipal(templateId);
    if (binding.authorizedPrincipals.length === 0) {
      throw invalid(
        'allow_template',
        'this binding allows every principal; name the principals that may use it on the Vault page first',
      );
    }
    if (binding.authorizedPrincipals.includes(principal)) return binding;
    return admin.putBinding(
      binding.handle,
      { authorizedPrincipals: [...binding.authorizedPrincipals, principal] },
      binding.version,
    );
  }
}

function invalid(path: string, message: string): AppError<'VALIDATION_FAILED'> {
  return validationFailed([{ path, message, code: 'invalid_relogin_link' }]);
}
