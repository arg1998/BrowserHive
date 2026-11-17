/** @module dashboard/test/fixtures/site-packs — typed builders for site-pack DTOs (a pack view, the list response with the registry status, a pack's content, its detail, a diff, a template site's pack) used by the site-pack, wizard, Sites tab and attention tests; shaped by the contracts schemas */
import type {
  SitePackDetailResponse,
  SitePackDiffResponse,
  SitePackRegistryStatus,
  SitePacksResponse,
  SitePackView,
  TemplateSitePack,
} from '@browserhive/contracts/http';
import type { SitePackV1Input } from '@browserhive/contracts/site-packs';

/** Server clock of the fixtures. */
export const PT0 = 1_700_000_000_000;

/** A SHA-256 made of one repeated hex digit. */
export function sha(digit: string): string {
  return digit.repeat(64);
}

/** A pack as operators see it: LinkedIn, bundled v3, approved, used by one template. */
export function packView(patch: Partial<SitePackView> = {}): SitePackView {
  return {
    pack_id: 'linkedin.com',
    title: 'LinkedIn',
    domains: ['linkedin.com', 'licdn.com'],
    identity_provider: null,
    approved: {
      version: 3,
      sha256: sha('a'),
      source: 'bundled',
      provenance: { kind: 'bundled', release: '0.3.0' },
      by: 'admin',
      at: PT0 - 86_400_000,
    },
    offer: null,
    previous: null,
    pinned_version: null,
    follow: { setting: 'auto', effective: true },
    enabled: true,
    local: null,
    local_override: false,
    pending: [],
    used_by: ['tp-0000000001'],
    human_only: false,
    write_policy_default: 'confirm',
    write_guards: 1,
    stance: 'prohibited',
    verified: { guards: '2026-11-10' },
    ...patch,
  };
}

/** A pack nothing approved yet, offered at bundled v2 (adding a site approves it). */
export function offeredPack(patch: Partial<SitePackView> = {}): SitePackView {
  return packView({
    pack_id: 'github.com',
    title: 'GitHub',
    domains: ['github.com'],
    approved: null,
    offer: {
      version: 2,
      sha256: sha('b'),
      source: 'bundled',
      provenance: { kind: 'bundled', release: '0.3.0' },
    },
    follow: { setting: 'auto', effective: false },
    used_by: [],
    write_policy_default: 'allow',
    write_guards: 0,
    stance: 'allowed',
    ...patch,
  });
}

/** The registry status: 2 bundled packs, an empty local folder. */
export function registryStatus(
  patch: Partial<SitePackRegistryStatus> = {},
): SitePackRegistryStatus {
  return {
    enabled: true,
    update_check: false,
    auto_update: false,
    url: null,
    last_check_at: null,
    last_ok_at: null,
    last_outcome: null,
    index_version: null,
    index_expires_at: null,
    stale: false,
    keys_version: null,
    bundled: { version: '0.3.0', built_at: null, count: 2 },
    local: { dir: '/data/site-packs/local', count: 0, signed_layouts: 0, needing_approval: 0 },
    skipped: [],
    last_load_at: PT0 - 60_000,
    ...patch,
  };
}

/** `GET /site-packs`. */
export function packsResponse(
  data: readonly SitePackView[],
  patch: Partial<SitePacksResponse> = {},
): SitePacksResponse {
  return {
    data: [...data],
    status: registryStatus(),
    pending_count: 0,
    local_needing_approval: 0,
    now: PT0,
    ...patch,
  };
}

/** A pack's content (LinkedIn-shaped). */
export function packContent(patch: Partial<SitePackV1Input> = {}): SitePackV1Input {
  return {
    schema: 1,
    id: 'linkedin.com',
    version: 3,
    min_client: '0.3.0',
    title: 'LinkedIn',
    domains: ['linkedin.com', 'licdn.com'],
    sign_in: { url: { host: 'www.linkedin.com', path: '/login' }, human_only: false },
    signed_in: {
      probe: { host: 'www.linkedin.com', path: '/feed/' },
      kind: 'redirect',
      signed_out_redirects: ['www.linkedin.com/uas/login*', 'www.linkedin.com/authwall*'],
      cookie_names: ['li_at'],
    },
    guards: [
      {
        id: 'logout',
        kind: 'logout',
        match: { url: 'www.linkedin.com/m/logout', methods: ['GET', 'POST'] },
        action: 'block',
      },
      {
        id: 'invite',
        kind: 'write',
        match: { url: 'www.linkedin.com/voyager/api/invite*' },
        action: 'write_policy',
      },
    ],
    element_guards: [
      {
        id: 'sign-out-button',
        kind: 'logout',
        page: 'www.linkedin.com/*',
        target: { role: 'menuitem', name: 'Sign Out' },
        action: 'block',
        request_guard: 'logout',
      },
    ],
    write_policy: {
      default: 'confirm',
      stance: 'prohibited',
      clause: {
        quote:
          'You agree that you will not use bots or other automated methods to access the Services.',
        url: 'https://www.linkedin.com/legal/user-agreement#dos',
        checked: '2026-11-01',
      },
    },
    challenges: [
      {
        id: 'checkpoint',
        kind: 'checkpoint',
        match: { url: 'www.linkedin.com/checkpoint/*' },
        action: 'attention',
      },
    ],
    pacing: {
      rules: [
        {
          id: 'invites',
          guard: 'invite',
          per: 'week',
          limit: 100,
          kind: 'vendor',
          source: { url: 'https://www.linkedin.com/help/linkedin/answer/a5487', kind: 'vendor' },
        },
      ],
    },
    strategies: [{ id: 'human-dwell', params: { min_ms: 800 } }],
    verified: { guards: '2026-11-10', sign_in: '2026-11-10' },
    sources: [{ url: 'https://www.linkedin.com/legal/user-agreement', kind: 'official' }],
    ...patch,
  };
}

/** `GET /site-packs/{id}`. */
export function packDetail(
  view: SitePackView = packView(),
  patch: Partial<SitePackDetailResponse> = {},
): Record<string, unknown> {
  return {
    view,
    pack: packContent(),
    versions: [{ version: 3, sha256: sha('a'), source: 'bundled', state: 'approved' }],
    ...patch,
  };
}

/** `GET /site-packs/{id}/diff`. */
export function packDiff(patch: Partial<SitePackDiffResponse> = {}): SitePackDiffResponse {
  return {
    from: { version: 3, sha256: sha('a'), source: 'bundled' },
    to: { version: 4, sha256: sha('c'), source: 'bundled' },
    classification: 'unclassified',
    new_domains: [],
    changes: [{ path: 'guards[logout].action', from: 'confirm', to: 'block', class: null }],
    ...patch,
  };
}

/** A template site's pack (the Sites tab card). */
export function templateSitePack(patch: Partial<TemplateSitePack> = {}): TemplateSitePack {
  return {
    pack_id: 'linkedin.com',
    title: 'LinkedIn',
    version: 3,
    sha256: sha('a'),
    source: 'bundled',
    local_override: false,
    identity_provider: null,
    human_only: false,
    sign_in_url: 'https://www.linkedin.com/login',
    stance: 'prohibited',
    write_policy_default: 'confirm',
    write_guards: 1,
    clause: {
      quote: 'You agree that you will not use bots or other automated methods.',
      url: 'https://www.linkedin.com/legal/user-agreement',
      checked: '2026-11-01',
    },
    exception: null,
    guards: 12,
    element_guards: 3,
    challenges: 4,
    enabled: true,
    ...patch,
  };
}
