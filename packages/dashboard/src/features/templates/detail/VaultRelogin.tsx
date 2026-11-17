/** @module features/templates/detail/VaultRelogin — the "Automatic re-login" row of a site card (spec 13 §8.4, §11.4): the linked vault binding, whether BrowserHive re-logs in by itself, why the binding would refuse it, the last automatic try; **Set up…** / **Change…** open the editor; "Not enabled" when the daemon has no vault (04 §11) */
import type { TemplateSiteView } from '@browserhive/contracts/http';
import { useState } from 'react';
import { useHasScope } from '@/app/providers/AuthProvider.tsx';
import { Chip } from '@/components/shared/Chip.tsx';
import { RelativeTime } from '@/components/shared/RelativeTime.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Hint } from '@/components/ui/tooltip.tsx';
import { useVaultEnabled } from '@/features/vault/api.ts';
import { ICONS } from '@/lib/icons.ts';
import { docsUrl } from '@/lib/links.ts';
import { useBindingChoices } from '../api-health.ts';
import { bindingProblemsOf } from '../relogin-text.ts';
import { ReloginLinkDialog } from './ReloginLinkDialog.tsx';

/** The row's content. */
export function VaultRelogin({
  templateId,
  templateName,
  site,
}: {
  readonly templateId: string;
  readonly templateName: string;
  readonly site: TemplateSiteView;
}) {
  const vaultEnabled = useVaultEnabled();
  const canLogin = useHasScope('templates:login');
  const canWriteVault = useHasScope('vault:write');
  const canLink = canLogin && canWriteVault;
  const bindings = useBindingChoices(vaultEnabled === true);
  const [open, setOpen] = useState(false);
  if (vaultEnabled === false) {
    return (
      <p className="text-muted-foreground">
        Not enabled: it needs the vault.{' '}
        <a
          href={docsUrl('vault')}
          target="_blank"
          rel="noreferrer"
          className="text-link underline decoration-link/40 underline-offset-2 hover:decoration-link"
        >
          Set up the vault
        </a>
      </p>
    );
  }
  const handle = site.vault_handle;
  const list = bindings.data?.data ?? [];
  const problems =
    handle === null || bindings.data === undefined
      ? []
      : bindingProblemsOf(
          list.find((b) => b.handle === handle),
          templateId,
        );
  const button = (
    <Button
      type="button"
      size="xs"
      variant="outline"
      disabled={!canLink}
      aria-label={`${handle === null ? 'Set up' : 'Change'} automatic re-login: ${site.site_id}`}
      onClick={() => setOpen(true)}
    >
      <ICONS.vault aria-hidden="true" />
      {handle === null ? 'Set up…' : 'Change…'}
    </Button>
  );
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <p className="flex min-w-0 flex-col">
          {handle === null ? (
            <span className="text-muted-foreground">
              Off. Link a vault binding to sign in again by itself.
            </span>
          ) : (
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="font-mono text-sm [overflow-wrap:anywhere]">{handle}</span>
              <Chip tone={site.auto_relogin ? 'success' : 'neutral'}>
                {site.auto_relogin ? 'Automatic' : 'Manual only'}
              </Chip>
              {problems.length > 0 ? (
                <Chip tone="warn">
                  {problems.length === 1 ? '1 problem' : `${problems.length} problems`}
                </Chip>
              ) : null}
            </span>
          )}
          {site.auto_relogin_at !== null ? (
            <span className="text-sm text-muted-foreground">
              Last automatic try{' '}
              <RelativeTime at={site.auto_relogin_at} className="min-w-0 text-sm" />
            </span>
          ) : null}
        </p>
        {canLink ? (
          button
        ) : (
          <Hint label="Needs templates:login and vault:write">
            {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a disabled button cannot take focus, so its wrapper carries the tooltip reason */}
            <span tabIndex={0} className="rounded-md focus-ring">
              {button}
            </span>
          </Hint>
        )}
      </div>
      {problems.length > 0 ? (
        <p className="text-sm text-warn-text">
          The vault would refuse this template’s fill. Open Change… to see why.
        </p>
      ) : null}
      <ReloginLinkDialog
        templateId={templateId}
        templateName={templateName}
        site={site}
        bindings={list}
        open={open}
        onClose={() => setOpen(false)}
      />
    </div>
  );
}
