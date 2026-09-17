/** @module lib/links — the one place for outbound links: browserhive.ai docs pages (checked against docs/ by links.test.ts), the website and the GitHub repository */

/** Public website. */
export const WEBSITE_URL = 'https://browserhive.ai';
/** Docs home on the website (latest major). */
export const DOCS_URL = `${WEBSITE_URL}/docs/`;
/** Source repository. */
export const REPO_URL = 'https://github.com/arg1998/BrowserHive';
/** New issue form. */
export const ISSUES_URL = `${REPO_URL}/issues/new`;
/** Release notes. */
export const RELEASES_URL = `${REPO_URL}/releases`;

/**
 * Docs pages the dashboard links to: the path under `/docs/` of the Markdown file in `docs/`
 * (without `.md`) and an optional heading anchor. Keep anchors to headings that exist, the test
 * resolves every entry.
 */
export const DOCS_PAGES = {
  home: { page: '' },
  quickStart: { page: 'guide/quick-start' },
  blocklistFile: { page: 'guide/quick-start', anchor: 'blocklist-file-format' },
  installation: { page: 'guide/installation' },
  mcpClients: { page: 'guide/mcp-clients' },
  agentTokens: { page: 'guide/mcp-clients', anchor: 'authentication-tokens' },
  dashboard: { page: 'guide/dashboard' },
  dashboardOverview: { page: 'guide/dashboard', anchor: 'overview' },
  dashboardSessions: { page: 'guide/dashboard', anchor: 'sessions' },
  dashboardSessionDetail: { page: 'guide/dashboard', anchor: 'session-detail' },
  dashboardAttention: { page: 'guide/dashboard', anchor: 'attention' },
  dashboardWebsites: { page: 'guide/dashboard', anchor: 'websites' },
  dashboardBlocklist: { page: 'guide/dashboard', anchor: 'blocklist' },
  dashboardVault: { page: 'guide/dashboard', anchor: 'vault' },
  dashboardVaultLog: { page: 'guide/dashboard', anchor: 'vault-log' },
  dashboardLogs: { page: 'guide/dashboard', anchor: 'logs' },
  dashboardSystem: { page: 'guide/dashboard', anchor: 'system' },
  dashboardNotifications: { page: 'guide/dashboard', anchor: 'notifications' },
  attention: { page: 'guide/attention' },
  attentionOperator: { page: 'guide/attention', anchor: 'the-operators-side' },
  vault: { page: 'guide/vault' },
  vaultPolicies: { page: 'guide/vault', anchor: 'folder-policies' },
  vaultBindings: { page: 'guide/vault', anchor: 'bindings' },
  vaultConfirmations: { page: 'guide/vault', anchor: '6-confirmations' },
  vaultAudit: { page: 'guide/vault', anchor: '7-audit' },
  stealth: { page: 'guide/stealth' },
  stealthLevels: { page: 'guide/stealth', anchor: 'levels' },
  security: { page: 'guide/security' },
  securityRecorded: { page: 'guide/security', anchor: 'what-is-recorded' },
  securityBlocklist: { page: 'guide/security', anchor: 'the-blocklist-is-not-an-egress-firewall' },
  securityAuth: { page: 'guide/security', anchor: 'authentication' },
  telemetry: { page: 'guide/telemetry' },
  configuration: { page: 'guide/configuration' },
  configurationPrecedence: { page: 'guide/configuration', anchor: 'precedence' },
  configurationReference: { page: 'reference/configuration' },
  upgrading: { page: 'guide/upgrading' },
  troubleshooting: { page: 'guide/troubleshooting' },
  troubleshootingDashboard: { page: 'guide/troubleshooting', anchor: 'dashboard' },
  tools: { page: 'reference/tools' },
  errors: { page: 'reference/errors' },
} as const satisfies Record<string, { readonly page: string; readonly anchor?: string }>;

/** Docs page key. */
export type DocsPage = keyof typeof DOCS_PAGES;

function withAnchor(page: string, anchor: string | undefined): string {
  const path = page === '' ? DOCS_URL : `${DOCS_URL}${page}/`;
  return anchor === undefined ? path : `${path}#${anchor}`;
}

/** Absolute URL of a docs page on browserhive.ai. */
export function docsUrl(key: DocsPage): string {
  const entry: { readonly page: string; readonly anchor?: string } = DOCS_PAGES[key];
  return withAnchor(entry.page, entry.anchor);
}

/** A configuration key in the reference (`maxSessions` → `…/reference/configuration/#maxSessions`). */
export function configKeyDocsUrl(key: string): string {
  return withAnchor('reference/configuration', key);
}

/** An error code in the reference (`SESSION_NOT_FOUND` → `…/reference/errors/#SESSION_NOT_FOUND`). */
export function errorCodeDocsUrl(code: string): string {
  return withAnchor('reference/errors', code);
}

/** An MCP tool in the reference (`vault_fill` → `…/reference/tools/#vault_fill`). */
export function toolDocsUrl(tool: string): string {
  return withAnchor('reference/tools', tool);
}

/** Release notes for one version (the tag Changesets creates). */
export function releaseUrl(version: string): string {
  return `${RELEASES_URL}/tag/browserhive@${version}`;
}
