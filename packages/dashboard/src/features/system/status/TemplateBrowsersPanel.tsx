/** @module features/system/status/TemplateBrowsersPanel — `/system` Status: the browsers of session templates (spec 13 §11.4 "Elsewhere"): one whole-row link per template whose browser is not stopped, with its state, agent pages and memory; hidden on a daemon without templates */
import type { TemplateSummary } from '@browserhive/contracts/http';
import { Panel } from '@/components/shared/Section.tsx';
import { StatusBadge } from '@/components/shared/StatusBadge.tsx';
import { LinkList, LinkRow } from '@/features/overview/components/LinkList.tsx';
import { useTemplatesOverview } from '@/features/templates/api.ts';
import { formatBytes } from '@/lib/format/bytes.ts';

/** Templates whose browser is up (or trying to be), in list order (pure, tested). */
export function runningTemplateBrowsers(
  templates: readonly TemplateSummary[],
): readonly TemplateSummary[] {
  return templates.filter((t) => t.host.state !== 'stopped');
}

/** Panel. */
export function TemplateBrowsersPanel() {
  const overview = useTemplatesOverview();
  const all = overview.data?.data ?? [];
  if (all.length === 0) return null;
  const rows = runningTemplateBrowsers(all);
  return (
    <Panel
      title="Template browsers"
      description="Each template runs one shared browser; it counts once against the session limit, however many sessions use it."
      info={
        <p>
          A template’s browser starts on its first launch or sign-in and stops after an idle hour.
          Its agent sessions are windows inside it.
        </p>
      }
      infoDocs="templatesBrowser"
      padding="none"
    >
      {rows.length === 0 ? (
        <p className="border-t px-5 py-3 text-sm text-muted-foreground">
          No template browser is running. They start when an agent launches a session from a
          template.
        </p>
      ) : (
        <LinkList label="Template browsers" className="border-t">
          {rows.map((t) => (
            <LinkRow
              key={t.template_id}
              href={`/templates/${encodeURIComponent(t.template_id)}`}
              label={`Open template ${t.display_name}`}
            >
              <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-medium decoration-muted-foreground/60 underline-offset-4 group-hover/row:underline">
                    {t.display_name}
                  </span>
                  <span className="truncate font-mono text-sm text-muted-foreground">{t.name}</span>
                </span>
                <StatusBadge domain="templateHost" value={t.host.state} className="text-sm" />
                <span className="text-sm text-muted-foreground tabular-nums">
                  {t.host.pages} {t.host.pages === 1 ? 'page' : 'pages'}
                  {t.host.rss_bytes !== undefined ? ` · ${formatBytes(t.host.rss_bytes)}` : ''}
                  {` · ${t.in_use} / ${t.cap} sessions`}
                </span>
              </div>
            </LinkRow>
          ))}
        </LinkList>
      )}
    </Panel>
  );
}
