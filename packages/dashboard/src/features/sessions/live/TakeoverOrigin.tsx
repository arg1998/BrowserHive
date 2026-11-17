/** @module features/sessions/live/TakeoverOrigin — during a takeover of a template session (spec 13 §8.4 Attention path): the page's real origin, shown prominently, and a warning when it is not on one of the template's sites, because an agent can stage a look-alike sign-in page and ask for attention; a warning for an unencrypted (`http:`) page; a neutral "can't check" while the template's sites load or can't be read (no `templates:read`), never the all-clear (review #81 L-6) */
import type { SessionSummary } from '@browserhive/contracts/http';
import { useTemplateDetail } from '@/features/templates/api.ts';
import { hostOnSites } from '@/features/templates/model.ts';
import { stripCredentials } from '@/lib/format/urls.ts';
import { ICONS } from '@/lib/icons.ts';
import { cn } from '@/lib/utils.ts';

/** `https://login.linkedin.com`, its host and whether it is encrypted, or `null` for a page without a web origin. */
export function pageOrigin(url: string | null): {
  readonly origin: string;
  readonly host: string;
  readonly secure: boolean;
} | null {
  if (url === null || url === '') return null;
  try {
    const parsed = new URL(stripCredentials(url));
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return { origin: parsed.origin, host: parsed.hostname, secure: parsed.protocol === 'https:' };
  } catch {
    return null;
  }
}

/** What the strip says about the origin: on a site, elsewhere, unencrypted, or not known. */
export type OriginCheck = 'ok' | 'foreign' | 'insecure' | 'unknown';

/** The check of a page against the template's sites (`null`: they couldn't be read). */
export function originCheck(
  page: { readonly host: string; readonly secure: boolean },
  sites: readonly string[] | null,
): OriginCheck {
  if (sites !== null && !hostOnSites(page.host, sites)) return 'foreign';
  if (!page.secure) return 'insecure';
  return sites === null ? 'unknown' : 'ok';
}

const TONE: { readonly [K in OriginCheck]: string } = {
  ok: 'bg-surface-inset',
  unknown: 'bg-surface-inset',
  foreign: 'bg-warn-bg text-warn-text',
  insecure: 'bg-warn-bg text-warn-text',
};

/** The strip; nothing for an exclusive session or a page without an origin. */
export function TakeoverOrigin({ session }: { readonly session: SessionSummary }) {
  const templateId = session.template?.template_id ?? undefined;
  const detail = useTemplateDetail(templateId ?? undefined);
  const page = pageOrigin(session.current_url);
  if (templateId === undefined || templateId === null || page === null) return null;
  const sites = detail.data?.sites.map((s) => s.site_id) ?? null;
  const check = originCheck(page, sites);
  const name = detail.data?.template.display_name ?? 'the template';
  const Icon = check === 'ok' ? ICONS.globe : check === 'unknown' ? ICONS.help : ICONS.warn;
  return (
    <div
      data-testid="takeover-origin"
      data-check={check}
      data-foreign={check === 'foreign' ? 'true' : 'false'}
      className={cn('flex shrink-0 flex-col gap-0.5 border-b px-3 py-2 text-sm', TONE[check])}
    >
      <p className="flex min-w-0 items-center gap-2">
        <Icon aria-hidden="true" className="size-4 shrink-0" />
        <span className="shrink-0 font-medium">Page origin</span>
        <span className="min-w-0 truncate font-mono text-base font-semibold text-foreground">
          {page.origin}
        </span>
      </p>
      {check === 'foreign' ? (
        <p className="pl-6 text-pretty" role="alert">
          This page is not on one of {name}’s sites ({sites?.join(', ')}). An agent can stage a
          look-alike sign-in page: don’t type a password here unless you know why it is open.
        </p>
      ) : check === 'insecure' ? (
        <p className="pl-6 text-pretty" role="alert">
          This page is not encrypted (http:). Don’t type a password here: anyone on the network can
          read it.
        </p>
      ) : check === 'unknown' ? (
        <p className="pl-6 text-pretty text-muted-foreground">
          {detail.isPending
            ? 'Checking it against the template’s sites…'
            : 'Can’t check it against the template’s sites. Make sure it is the site you expect before you type a password.'}
        </p>
      ) : null}
    </div>
  );
}
