/** @module features/site-packs/RegistryCard — where packs come from (spec 13 §10.5, §11.4 without the registry parts, T3a): the packs bundled with this release, the local folder with its file counts, when packs were last loaded, every version that was skipped and why, and that registry updates from browserhive.ai arrive with a later release */
import type { SitePackRegistryStatus } from '@browserhive/contracts/http';
import type { ReactNode } from 'react';
import { RelativeTime } from '@/components/shared/RelativeTime.tsx';
import { Panel } from '@/components/shared/Section.tsx';
import { configKeyDocsUrl, docsUrl } from '@/lib/links.ts';
import { SKIP_REASON_TEXT, SOURCE_LABEL } from './model.ts';

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-base [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

/** The Registry card. */
export function RegistryCard({ status }: { readonly status: SitePackRegistryStatus }) {
  const { local, bundled } = status;
  return (
    <Panel
      title="Where packs come from"
      info={
        <p>
          Packs bundled with BrowserHive and pack files in the local folder are loaded at start and
          when you press Reload local packs. A local file applies only after you approve its exact
          content.
        </p>
      }
      infoDocs="sitePacksLocal"
    >
      <dl className="grid min-w-0 gap-x-8 gap-y-4 sm:grid-cols-2 xl:grid-cols-4">
        <Fact label="Bundled">
          {bundled.count} {bundled.count === 1 ? 'pack' : 'packs'} with BrowserHive{' '}
          {bundled.version}
        </Fact>
        <Fact label="Local folder">
          <span className="font-mono text-sm">{local.dir}</span>
          <span className="block text-sm text-muted-foreground">
            {local.count} {local.count === 1 ? 'file' : 'files'}
            {local.needing_approval > 0 ? ` · ${local.needing_approval} need approval` : ''}
            {local.signed_layouts > 0
              ? ` · ${local.signed_layouts} signed ${local.signed_layouts === 1 ? 'layout' : 'layouts'} skipped`
              : ''}
          </span>
        </Fact>
        <Fact label="Last loaded">
          {status.last_load_at !== null ? (
            <RelativeTime at={status.last_load_at} mode="both" />
          ) : (
            'Not yet'
          )}
        </Fact>
        <Fact label="Registry updates">
          <span className="text-pretty">
            Updates from browserhive.ai arrive with a later release. Until then a new BrowserHive
            brings new bundled versions, and you can import a file.
          </span>
          <a
            href={docsUrl('sitePacksWriting')}
            target="_blank"
            rel="noreferrer"
            className="mt-1 block text-sm text-link underline decoration-link/40 underline-offset-2 hover:decoration-link"
          >
            Write a local pack
          </a>
          <a
            href={configKeyDocsUrl('sitePacksDir')}
            target="_blank"
            rel="noreferrer"
            className="mt-1 block text-sm text-link underline decoration-link/40 underline-offset-2 hover:decoration-link"
          >
            Change the local folder (sitePacksDir)
          </a>
        </Fact>
      </dl>
      {status.skipped.length > 0 ? (
        <div className="mt-5 flex flex-col gap-2 border-t pt-4">
          <h3 className="text-sm font-medium">Skipped when loading</h3>
          <ul className="flex flex-col gap-1.5 text-sm">
            {status.skipped.map((s) => (
              <li
                key={`${s.source}:${s.pack_id}:${s.version ?? 'x'}`}
                className="min-w-0 [overflow-wrap:anywhere]"
              >
                <span className="font-medium">{s.pack_id}</span>
                {s.version !== null ? ` v${s.version}` : ''} · {SOURCE_LABEL[s.source]}:{' '}
                {SKIP_REASON_TEXT[s.reason]}
                {s.detail !== '' ? (
                  <span className="text-muted-foreground"> ({s.detail})</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Panel>
  );
}
