/** @module app/templates/views — records → the wire shapes of spec 13 §2.1 and §11.1 (operators) and §5.1 (agents). Agents get only names, descriptions, site states, availability and `sealed`. */

import type {
  HostView,
  ReloginView,
  Template,
  TemplateDetailResponse,
  TemplateSiteView,
  TemplateSummary,
} from '@browserhive/contracts/http';
import type { AgentTemplate } from '@browserhive/contracts/tools';
import { type Availability, effectiveCap, isTemplateSealed } from '../../domain/templates/model.ts';
import type { TemplateRecord, TemplateSiteRecord } from '../../ports/persistence/index.ts';
import type { TemplateHostView } from '../../ports/template-runtime.ts';
import { NO_PACKS, type TemplatePacks } from './template-packs.ts';

/** The pack lookup the views use (the pack in force for a site's `pack_id`). */
export type SitePackReader = Pick<TemplatePacks, 'sitePackOf'>;

/** A site's display title: its pack's title when a pack applies (T3a), else the domain. */
export function siteTitle(site: TemplateSiteRecord, packs: SitePackReader = NO_PACKS): string {
  return packs.sitePackOf(site.packId)?.title ?? site.siteId;
}

/** One site for operators, with the pack in force (spec 13 §11.4). */
export function toSiteView(
  site: TemplateSiteRecord,
  packs: SitePackReader = NO_PACKS,
): TemplateSiteView {
  const pack = packs.sitePackOf(site.packId);
  return {
    site_id: site.siteId,
    title: pack?.title ?? site.siteId,
    pack_id: site.packId,
    pack_version: site.packVersion,
    enabled: site.enabled,
    write_policy: site.writePolicy,
    vault_handle: site.vaultHandle,
    auto_relogin: site.autoRelogin,
    auto_relogin_at: site.autoReloginAt,
    form: site.form === null ? null : { ...site.form },
    learned_cookie_names: [...site.learnedCookieNames],
    health: {
      state: site.health.state,
      checked_at: site.health.checkedAt,
      changed_at: site.health.changedAt,
      reason: site.health.reason,
      consecutive_inconclusive: site.health.consecutiveInconclusive,
    },
    stopped_at: site.stoppedAt,
    device_bound: site.deviceBound,
    added_at: site.addedAt,
    pack,
  };
}

/** The template for operators (`Template`, spec 13 §2.1); `proxy.password_env` is a name, never a value. */
export function toTemplateView(
  template: TemplateRecord,
  sites: readonly TemplateSiteRecord[],
  packs: SitePackReader = NO_PACKS,
): Template {
  const id = template.identity;
  const observed = template.identityObserved;
  return {
    template_id: template.templateId,
    name: template.name,
    display_name: template.displayName,
    description: template.description,
    status: template.status,
    owner: template.owner,
    sites: sites.map((s) => toSiteView(s, packs)),
    identity: {
      seed: id.seed,
      locale: id.locale,
      languages: [...id.languages],
      timezone_id: id.timezoneId,
      country_code: id.countryCode,
      ...(id.geolocation !== undefined && { geolocation: { ...id.geolocation } }),
    },
    identity_observed:
      observed === null
        ? null
        : {
            chrome_major: observed.chromeMajor,
            user_agent: observed.userAgent,
            ua_ch: {
              brands: observed.uaCh.brands.map((b) => ({ ...b })),
              full_version_list: observed.uaCh.fullVersionList.map((b) => ({ ...b })),
              platform: observed.uaCh.platform,
              platform_version: observed.uaCh.platformVersion,
              architecture: observed.uaCh.architecture,
              bitness: observed.uaCh.bitness,
            },
            screen: {
              width: observed.screen.width,
              height: observed.screen.height,
              device_scale_factor: observed.screen.deviceScaleFactor,
            },
            window: { ...observed.window },
            observed_at: observed.observedAt,
          },
    channel: template.channel,
    headless: template.headless,
    stealth: template.stealth,
    fingerprint: template.fingerprint,
    humanize: template.humanize,
    proxy:
      template.proxy === null
        ? null
        : {
            server: template.proxy.server,
            bypass: template.proxy.bypass,
            username: template.proxy.username,
            password_env: template.proxy.passwordEnv,
            label: template.proxy.label,
          },
    policy: {
      authorized_principals: [...template.authorizedPrincipals],
      ...(template.harnesses !== null && { harnesses: [...template.harnesses] }),
      max_concurrent: template.maxConcurrent,
      unseal: {
        cookie_values: template.unseal.cookieValues,
        evaluate: template.unseal.evaluate,
        cookie_writes: template.unseal.cookieWrites,
        state_export: template.unseal.stateExport,
        ...(template.unseal.principals !== null && {
          principals: [...template.unseal.principals],
        }),
      },
      health_interval_ms: template.healthIntervalMs,
      prelaunch_check: template.prelaunchCheck,
    },
    agent_windows: template.agentWindows,
    deny_clipboard_writes: template.denyClipboardWrites,
    current_version: template.currentVersion,
    checkpoint_at: template.checkpointAt,
    checkpoint_size_bytes: template.checkpointSizeBytes,
    version: template.version,
    created_at: template.createdAt,
    updated_at: template.updatedAt,
    last_used_at: template.lastUsedAt,
    disabled_at: template.disabledAt,
  };
}

/** The host for operators (`HostView`). */
export function toHostView(host: TemplateHostView): HostView {
  return {
    state: host.state,
    since: host.since,
    started_at: host.startedAt,
    restarts: host.restarts,
    ...(host.lastError !== null && { last_error: host.lastError }),
    pages: host.pages,
    parked_pages: host.parkedPages.length,
    ...(host.rssBytes !== null && { rss_bytes: host.rssBytes }),
    ...(host.recycleAt !== null && { recycle_at: host.recycleAt }),
    sandboxed: host.sandboxed,
    profile_secrets: host.profileSecrets,
    agents_paused: host.agentsPaused,
  };
}

/** `GET /templates/{template_id}` (spec 13 §11.1). */
export function toTemplateDetail(
  template: TemplateRecord,
  sites: readonly TemplateSiteRecord[],
  host: TemplateHostView,
  sessionsLive: number,
  now: number,
  live: {
    readonly unlistedDomains: readonly string[];
    readonly relogin?: ReloginView | null;
    readonly machine?: string;
  } = { unlistedDomains: [] },
  packs: SitePackReader = NO_PACKS,
): TemplateDetailResponse {
  return {
    template: toTemplateView(template, sites, packs),
    host: toHostView(host),
    sites: sites.map((s) => toSiteView(s, packs)),
    sessions_live: sessionsLive,
    parked_pages: host.parkedPages.map((p) => ({
      target_id: p.targetId,
      url: p.url,
      title: p.title,
      opened_at: p.openedAt,
    })),
    shared_windows: host.sharedWindows.map((w) => ({
      window_id: w.windowId,
      session_ids: [...w.sessionIds],
    })),
    // From the running browser's jar and the newest version's summary (spec 13 §2.3).
    unlisted_domains: [...live.unlistedDomains],
    relogin: live.relogin ?? null,
    machine: { name: live.machine ?? '' },
    now,
  };
}

/** One row of `GET /templates`. */
export function toTemplateSummary(
  template: TemplateRecord,
  sites: readonly TemplateSiteRecord[],
  host: TemplateHostView,
  packs: SitePackReader = NO_PACKS,
): TemplateSummary {
  return {
    template_id: template.templateId,
    name: template.name,
    display_name: template.displayName,
    status: template.status,
    channel: template.channel,
    headless: template.headless,
    sites: sites.map((s) => ({
      site_id: s.siteId,
      title: siteTitle(s, packs),
      health_state: s.health.state,
      checked_at: s.health.checkedAt,
    })),
    host: {
      state: host.state,
      since: host.since,
      pages: host.pages,
      ...(host.rssBytes !== null && { rss_bytes: host.rssBytes }),
    },
    in_use: host.liveAgentSessions,
    cap: effectiveCap(template),
    current_version: template.currentVersion,
    checkpoint_at: template.checkpointAt,
    last_used_at: template.lastUsedAt,
    sealed: isTemplateSealed(template.unseal),
    ...(driftOf(template, host) !== undefined && { identity_drift: driftOf(template, host) }),
  };
}

/**
 * One `list_templates` entry (spec 13 §5.1): only what an agent needs to choose and launch.
 * Disabled sites are left out; no id, owner, count, mode or host fact is included.
 */
export function toAgentTemplate(
  template: TemplateRecord,
  sites: readonly TemplateSiteRecord[],
  availability: Availability,
  sealed: boolean,
  packs: SitePackReader = NO_PACKS,
): AgentTemplate {
  return {
    name: template.name,
    display_name: template.displayName,
    description: template.description,
    sites: sites
      .filter((s) => s.enabled)
      .map((s) => ({
        site: s.siteId,
        title: siteTitle(s, packs),
        status: s.health.state,
        checked_at: s.health.checkedAt,
      })),
    availability,
    sealed,
  };
}

/** The drift the last start saw: the running process's, else the one stored with the row (deferred D23). */
function driftOf(
  template: TemplateRecord,
  host: TemplateHostView,
): { from: string; to: string } | undefined {
  const drift = host.identityDrift ?? template.identityObserved?.drift;
  return drift === undefined ? undefined : { from: drift.from, to: drift.to };
}
