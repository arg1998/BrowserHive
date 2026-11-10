/** @module contracts/tools/templates — list_templates and the template shapes agents see (spec 13 §5.1, D-49, D-51) */
import { z } from 'zod';
import { TemplateAvailability } from '../enums/template-availability.ts';
import { TemplateHealthState } from '../enums/template-health-state.ts';
import { annotations } from './shared.ts';
import { defineTool } from './types.ts';

/**
 * Template name grammar (spec 13 §2.1): the session slug grammar, so a name reads like the slugs an
 * agent already passes. What agents pass as `launch_session.template`.
 */
export const TEMPLATE_NAME_RE = /^[a-z][a-z0-9-]{1,31}$/;

/**
 * Semver of first appearance of the template surface (`list_templates`, `launch_session.template`).
 * 0.3.0 is planned for other work (#57, #60), so templates ship in 0.4.0 at the earliest; the final
 * feature PR moves this if they ship later.
 */
export const TEMPLATES_SINCE = '0.4.0';

/** One site of a template as an agent sees it: the registrable domain, a title and its sign-in state. */
export const AgentTemplateSite = z.object({
  site: z.string(),
  title: z.string(),
  status: TemplateHealthState,
  checked_at: z.number().nullable(),
});
/** Parsed {@link AgentTemplateSite}. */
export type AgentTemplateSite = z.infer<typeof AgentTemplateSite>;

/**
 * One `list_templates` entry. Only what an agent needs to choose and launch: no id, owner, session
 * count, mode or anything about other sessions (spec 13 §5, D-09).
 */
export const AgentTemplate = z.object({
  name: z.string(),
  display_name: z.string(),
  description: z.string(),
  sites: z.array(AgentTemplateSite),
  availability: TemplateAvailability,
  sealed: z.boolean(),
});
/** Parsed {@link AgentTemplate}. */
export type AgentTemplate = z.infer<typeof AgentTemplate>;

/** The additive `template` key of a template session's metadata (spec 13 §5.2); absent otherwise. */
export const SessionTemplateInfo = z.object({
  name: z.string(),
  sites: z.array(z.object({ site: z.string(), status: TemplateHealthState })),
});
/** Parsed {@link SessionTemplateInfo}. */
export type SessionTemplateInfo = z.infer<typeof SessionTemplateInfo>;

/** Agent-facing description of `list_templates` (spec 13 §5.1; wording rule of §5). */
export const LIST_TEMPLATES_DESCRIPTION =
  "List the session templates you may use. A session launched with a template's name as `template` " +
  "starts signed in to the template's sites. The sign-ins belong to the operator: do not sign out, and " +
  'do not change account, security or privacy settings; such actions may be blocked or need the ' +
  "operator's approval. Sign-ins and site data the session changes are kept in the template and " +
  'carried into later sessions from it. Cookie values are hidden, and evaluate and saving the login ' +
  'are unavailable unless the operator allows them.';

/** The MCP server `instructions` sentence about templates (spec 13 §5.1); present while `templates` is on. */
export const TEMPLATES_SERVER_INSTRUCTION =
  'Use list_templates to find session templates the operator has signed in to sites; launch_session with template starts a session that is signed in to them.';

/**
 * The `INVALID_ARGUMENTS` issue text for a launch option a template fixes (spec 13 §5.3):
 * `template '<name>' fixes <option>; omit it`.
 */
export function templateFixesOptionText(template: string, option: string): string {
  return `template '${template}' fixes ${option}; omit it`;
}

/** The `limit_text` of `TEMPLATE_BUSY` per `limit_kind` (spec 13 §12). */
export const TEMPLATE_BUSY_LIMIT_TEXT = {
  capacity: (template: string) => `Template '${template}' is at capacity.`,
  tabs: () => 'This session has reached its tab limit; close a tab you no longer need.',
  pace: (site: string) => `Actions on ${site} are being paced.`,
} as const;

/** The `note` of `vault_list_available` in a template session (spec 13 §5.5, templates T1a-3). */
export const TEMPLATE_VAULT_NOTE =
  'Vault fills are not available in template sessions; the operator keeps the template signed in.';

/** `list_templates`: the templates the caller may launch, sorted by name (spec 13 §5.1). */
export const LIST_TEMPLATES = defineTool({
  name: 'list_templates',
  title: 'List templates',
  description: LIST_TEMPLATES_DESCRIPTION,
  input: z.object({}).strict(),
  output: z.object({ templates: z.array(AgentTemplate) }),
  annotations: annotations(true, false, true, false),
  pack: 'templates',
  capability: 'read',
  errors: ['TOOL_NOT_AVAILABLE'],
  since: TEMPLATES_SINCE,
});
