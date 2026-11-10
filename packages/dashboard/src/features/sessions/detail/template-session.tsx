/** @module features/sessions/detail/template-session — what the session page shows for a session launched from a template (spec 13 §11.4 "Elsewhere"): the "Template: <name>" badge linking to the template, the "Sign-ins protected" pill, "BrowserHive (system)" for BrowserHive's own sessions, the Files tab's note that tracing is off, and the Identity card's pointer to the template's pinned identity */
import type { SessionSummary } from '@browserhive/contracts/http';
import { Link } from '@tanstack/react-router';
import { Panel } from '@/components/shared/Section.tsx';
import { TonePill } from '@/components/shared/StatusBadge.tsx';
import { useTemplatesOverview } from '@/features/templates/api.ts';
import { ICONS } from '@/lib/icons.ts';
import { cn } from '@/lib/utils.ts';

/** The template part of a session summary. */
export type SessionTemplate = NonNullable<SessionSummary['template']>;

/** Hint of the "Sign-ins protected" pill (spec 13 §5.4). */
export const SEALED_HINT =
  "Agents in this session can't read cookie values, run page scripts or save the sign-in";

/** The template's display name from the shared template list, else its name at launch. */
export function useTemplateLabel(template: SessionTemplate | undefined): string | null {
  const overview = useTemplatesOverview(template?.template_id != null);
  if (template === undefined) return null;
  const row = overview.data?.data.find((t) => t.template_id === template.template_id);
  return row?.display_name ?? template.name;
}

const PILL =
  'inline-flex h-5.5 max-w-full items-center gap-1.5 rounded-full border border-border px-2 text-xs font-medium whitespace-nowrap text-foreground';

/** Header badges of a template session; nothing for an exclusive session. */
export function TemplateSessionBadges({ session }: { readonly session: SessionSummary }) {
  const template = session.template;
  const label = useTemplateLabel(template);
  if (template === undefined || label === null) return null;
  const Icon = ICONS.templates;
  const body = (
    <>
      <Icon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">Template: {label}</span>
    </>
  );
  return (
    <>
      {template.template_id !== null ? (
        <Link
          to="/templates/$id"
          params={{ id: template.template_id }}
          className={cn(PILL, 'focus-ring hover:border-border-strong hover:bg-accent')}
        >
          {body}
        </Link>
      ) : (
        <span className={PILL}>{body}</span>
      )}
      {template.mode === 'maintenance' ? (
        <TonePill
          entry={{
            label: 'BrowserHive (system)',
            tone: 'info',
            hint: 'BrowserHive opened this session itself (a sign-in window or upkeep); agents never see it',
          }}
        />
      ) : null}
      {session.sealed === true ? (
        <TonePill
          entry={{
            label: 'Sign-ins protected',
            tone: 'success',
            icon: 'secured',
            hint: SEALED_HINT,
          }}
        />
      ) : null}
    </>
  );
}

/** Files tab: tracing is off for template sessions, so there is no trace.zip. */
export function TemplateTraceNote() {
  return (
    <Panel
      title="Playwright trace"
      description="Tracing is off for sessions launched from a template."
    >
      <p className="max-w-2xl text-sm text-pretty text-muted-foreground">
        A trace would record the signed-in account’s cookies, storage and page contents, so
        BrowserHive never traces template sessions. The activity timeline and screenshots are still
        recorded.
      </p>
    </Panel>
  );
}

/** Identity card line: the identity is the template's, pinned when it was created. */
export function TemplateIdentityNote({ template }: { readonly template: SessionTemplate }) {
  return (
    <p className="text-sm text-muted-foreground">
      This identity belongs to the template and is pinned: every session launched from it presents
      the same device, locale and time zone.{' '}
      {template.template_id !== null ? (
        <Link
          to="/templates/$id"
          params={{ id: template.template_id }}
          search={{ tab: 'settings' }}
          className="text-link hover:underline"
        >
          See the template’s identity
        </Link>
      ) : null}
    </p>
  );
}
