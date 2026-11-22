/** @module features/templates/detail/SitePackRows — a site's pack on its Sites-tab card (spec 13 §9.3, §9.6, §11.4): the pack's title, version and source ("Local file overrides vN"), sign in by hand only, "What the site's terms say" as a label with the clause quoted verbatim (checked date, address as text) and the exception, the write policy select ("Pack default: Confirm"; off with a note when the pack guards no writes yet), the guard, guarded-control and security-check counts linking to the pack page; for a generic site whose domain now has a pack, **Use the … site pack** (`PUT` with the `pack_sha256` the confirmation names) */

import type { TemplateSitePack, TemplateSiteView } from '@browserhive/contracts/http';
import { Link } from '@tanstack/react-router';
import { useId } from 'react';
import { useConfirm } from '@/app/providers/ConfirmProvider.tsx';
import { useToast } from '@/app/providers/ToastProvider.tsx';
import { Chip } from '@/components/shared/Chip.tsx';
import { Plain } from '@/components/shared/Plain.tsx';
import { Button } from '@/components/ui/button.tsx';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select.tsx';
import { useSitePackCatalog } from '@/features/site-packs/api.ts';
import { attachPackConfirm } from '@/features/site-packs/confirm-copy.ts';
import {
  iso,
  NO_WRITE_GUARDS,
  packChoice,
  packForHost,
  SOURCE_LABEL,
  WRITE_POLICY_HINT,
  WRITE_POLICY_LABEL,
  type WritePolicy,
} from '@/features/site-packs/model.ts';
import {
  LocalOverrideBadge,
  ShaText,
  StanceLabel,
  TermsClause,
} from '@/features/site-packs/PackBits.tsx';
import { packUpdateHint } from '@/features/site-packs/registry-model.ts';
import { useTemplateOperations } from '../api-operations.ts';
import { Row } from './site-row.tsx';

const DEFAULT = 'default';

/** The write policy select. */
function WritePolicySelect({
  templateId,
  site,
  pack,
}: {
  readonly templateId: string;
  readonly site: TemplateSiteView;
  readonly pack: TemplateSitePack;
}) {
  const ops = useTemplateOperations(templateId);
  const toast = useToast();
  const labelId = useId();
  const items = [
    { value: DEFAULT, label: `Pack default: ${WRITE_POLICY_LABEL[pack.write_policy_default]}` },
    ...(['allow', 'warn', 'confirm'] as const).map((p) => ({
      value: p,
      label: WRITE_POLICY_LABEL[p],
    })),
  ];
  const effective: WritePolicy = site.write_policy ?? pack.write_policy_default;
  // A pack without write guards has nothing for the policy to act on (review S-H3): say so instead
  // of promising that writes wait for approval.
  const inert = pack.write_guards === 0;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span id={labelId} className="sr-only">
        Write policy for {site.site_id}
      </span>
      <Select
        items={items}
        value={site.write_policy ?? DEFAULT}
        onValueChange={(next) => {
          const write_policy =
            next === 'allow' || next === 'warn' || next === 'confirm' ? next : null;
          ops.putSite.mutate(
            { site: site.site_id, body: { write_policy } },
            {
              onSuccess: () =>
                toast.success({
                  title: `${iso(site.title)}: writes ${WRITE_POLICY_LABEL[write_policy ?? pack.write_policy_default].toLowerCase()}`,
                }),
            },
          );
        }}
      >
        <SelectTrigger
          disabled={ops.putSite.isPending || inert}
          aria-labelledby={labelId}
          className="w-full sm:w-64"
        >
          <SelectValue className="truncate" />
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false} align="start">
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <span className="text-sm text-muted-foreground">
        {inert ? NO_WRITE_GUARDS : WRITE_POLICY_HINT[effective]}
      </span>
    </div>
  );
}

/** "Use the LinkedIn site pack" for a generic site whose domain has a pack. */
function UsePack({
  templateId,
  site,
}: {
  readonly templateId: string;
  readonly site: TemplateSiteView;
}) {
  const catalog = useSitePackCatalog();
  const ops = useTemplateOperations(templateId);
  const confirm = useConfirm();
  const toast = useToast();
  const packs = catalog.data?.status.enabled === true ? catalog.data.data : [];
  const pack = packForHost(packs, site.site_id);
  const choice = pack === null ? null : packChoice(pack);
  if (pack === null || choice === null) {
    return <p className="text-muted-foreground">None: a generic site, detected by its cookies.</p>;
  }
  const onUse = async () => {
    if (!(await confirm(attachPackConfirm(pack, choice, site.site_id)))) return;
    ops.putSite.mutate(
      { site: site.site_id, body: { pack_sha256: choice.sha256 } },
      {
        onSuccess: () =>
          toast.success({ title: `${site.site_id} uses the ${iso(pack.title)} pack` }),
      },
    );
  };
  return (
    <div className="flex flex-col items-start gap-2">
      <p className="text-muted-foreground">
        None yet. BrowserHive has a <Plain>{pack.title}</Plain> pack (v{choice.version},{' '}
        <Plain>{choice.provenanceShort}</Plain>).
      </p>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={ops.putSite.isPending}
        onClick={() => void onUse()}
      >
        Use the <Plain>{pack.title}</Plain> site pack…
      </Button>
    </div>
  );
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The pack's update state from the Site packs catalog, linking to the pack (review #100 M6). */
function PackUpdateChip({ packId }: { readonly packId: string }) {
  const catalog = useSitePackCatalog();
  const view = catalog.data?.data.find((p) => p.pack_id === packId);
  const hint = view === undefined ? null : packUpdateHint(view);
  if (hint === null) return null;
  return (
    <Link
      to="/site-packs/$id"
      params={{ id: packId }}
      className="rounded-md focus-ring"
      data-pack-update=""
    >
      <Chip tone={hint.tone} className="hover:underline underline-offset-2">
        {hint.text}
      </Chip>
    </Link>
  );
}

/** The pack rows of a site card. */
export function SitePackRows({
  templateId,
  site,
}: {
  readonly templateId: string;
  readonly site: TemplateSiteView;
}) {
  const pack = site.pack;
  if (pack === null) {
    return (
      <>
        <Row label="Site pack">
          <UsePack templateId={templateId} site={site} />
        </Row>
        <Row label="Writes">
          <p className="text-muted-foreground">A write policy applies with a site pack.</p>
        </Row>
      </>
    );
  }
  return (
    <>
      <Row label="Site pack">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="flex flex-wrap items-center gap-2">
            <Link
              to="/site-packs/$id"
              params={{ id: pack.pack_id }}
              className="font-medium text-link underline decoration-link/40 underline-offset-2 hover:decoration-link"
            >
              <Plain>{pack.title}</Plain>
            </Link>
            <span className="tabular-nums">v{pack.version}</span>
            <Chip tone="neutral">{SOURCE_LABEL[pack.source]}</Chip>
            {pack.local_override ? <LocalOverrideBadge version={null} /> : null}
            {!pack.enabled ? <Chip tone="muted">Turned off</Chip> : null}
            <PackUpdateChip packId={pack.pack_id} />
          </span>
          <ShaText sha256={pack.sha256} className="text-muted-foreground" />
          {pack.human_only ? (
            <span className="text-sm text-muted-foreground">
              Sign in by hand only: automatic re-login is unavailable for this site.
            </span>
          ) : null}
          {!pack.enabled ? (
            <span className="text-sm text-muted-foreground">
              The pack is turned off on Site packs, so the site acts as a generic site.
            </span>
          ) : null}
        </div>
      </Row>
      <Row label="What the site’s terms say">
        <div className="flex min-w-0 flex-col items-start gap-2">
          <StanceLabel stance={pack.stance} />
          {pack.clause !== null ? <TermsClause clause={pack.clause} /> : null}
          {pack.exception !== null ? (
            <p className="text-sm text-pretty">
              <span className="font-medium">Why the pack’s default differs:</span>{' '}
              <Plain>{pack.exception}</Plain>
            </p>
          ) : null}
        </div>
      </Row>
      <Row label="Writes">
        <WritePolicySelect templateId={templateId} site={site} pack={pack} />
      </Row>
      <Row label="Rules">
        <Link
          to="/site-packs/$id"
          params={{ id: pack.pack_id }}
          className="text-link underline decoration-link/40 underline-offset-2 hover:decoration-link"
        >
          {count(pack.guards, 'guard', 'guards')} ·{' '}
          {count(pack.element_guards, 'guarded control', 'guarded controls')} ·{' '}
          {count(pack.challenges, 'security check', 'security checks')}
        </Link>
      </Row>
    </>
  );
}
