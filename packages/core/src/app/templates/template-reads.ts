/** @module app/templates/template-reads — reading every template with its sites, optionally skipping rows this binary cannot read so one bad row never hides every template from agents (spec 13 §5.1). */

import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { DegradationReporter } from '../../ports/degradation-reporter.ts';
import type { Logger } from '../../ports/logger.ts';
import type {
  Repositories,
  TemplateRecord,
  TemplateSiteRecord,
} from '../../ports/persistence/index.ts';

/** The degradation code of a template row `list_templates` had to skip. */
export const ROW_UNREADABLE = 'TEMPLATE_ROW_UNREADABLE';

/** Every template and its sites, by template id. */
export interface TemplateSet {
  readonly templates: readonly TemplateRecord[];
  readonly sites: ReadonlyMap<string, readonly TemplateSiteRecord[]>;
}

/** Where skipped rows are reported. */
export interface UnreadableSink {
  readonly log: Logger;
  readonly degradations: DegradationReporter;
}

/**
 * Reads every template and its sites. With a `sink` (the agent list), an unreadable row is skipped,
 * logged and recorded as `TEMPLATE_ROW_UNREADABLE`, and a template with an unreadable site row is
 * left out entirely; a clean read clears the degradation. Without one (the operator list) a bad row
 * fails the read.
 */
export async function readTemplates(
  repos: Pick<Repositories, 'templates' | 'templateSites'>,
  sink: UnreadableSink | null,
): Promise<TemplateSet> {
  const broken = new Set<string>();
  const report = (table: 'templates' | 'template_sites') => ({
    onUnreadable: (templateId: string, error: unknown) => {
      broken.add(templateId);
      sink?.log.warn('template row unreadable', { templateId, table, err: serializeError(error) });
      sink?.degradations.report({
        code: ROW_UNREADABLE,
        severity: 'warn',
        message: `A stored row of template '${templateId}' cannot be read; agents do not see the template.`,
        details: {
          template_id: templateId,
          table,
          reason: error instanceof Error ? error.message : 'unreadable',
        },
      });
    },
  });
  const [read, all] = await Promise.all([
    repos.templates.listAll(sink === null ? {} : report('templates')),
    repos.templateSites.listAll(sink === null ? {} : report('template_sites')),
  ]);
  if (sink !== null && broken.size === 0) sink.degradations.recovered(ROW_UNREADABLE);
  const sites = new Map<string, TemplateSiteRecord[]>();
  for (const site of all) {
    const list = sites.get(site.templateId);
    if (list === undefined) sites.set(site.templateId, [site]);
    else list.push(site);
  }
  return { templates: read.filter((t) => !broken.has(t.templateId)), sites };
}
