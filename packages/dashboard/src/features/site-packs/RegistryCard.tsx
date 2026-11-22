/** @module features/site-packs/RegistryCard — where packs come from (spec 13 §10.4, §10.5, §10.9, §11.4): the update check with the configuration key that controls it, the registry URL, the last and next check, auto-update; the held signed index (version, issued, expiry, signing key, where it came from, keys version); what a check sends (D-55); why no check runs (update check off, no trusted registry); the release snapshot, bundled packs and the local folder; every version skipped and why; **Import…** and **Reload local packs**. `RegistryAlert` puts an out-of-date index (with a clock hint) and a failing check on top of the page */
import type { SitePackRegistryStatus } from '@browserhive/contracts/http';
import type { ReactNode } from 'react';
import { Callout } from '@/components/shared/Callout.tsx';
import { KeyValue, type KeyValueItem } from '@/components/shared/KeyValue.tsx';
import { RelativeTime } from '@/components/shared/RelativeTime.tsx';
import { Panel } from '@/components/shared/Section.tsx';
import { formatDuration } from '@/lib/format/time.ts';
import { ICONS } from '@/lib/icons.ts';
import { configKeyDocsUrl, docsUrl } from '@/lib/links.ts';
import { ImportMenu, type ImportPicker } from './ImportPack.tsx';
import { SKIP_REASON_TEXT, SOURCE_LABEL } from './model.ts';
import { CHECK_OFF_TEXT, CHECK_SENDS } from './registry-model.ts';

const LINK =
  'text-link underline decoration-link/40 underline-offset-2 hover:decoration-link focus-ring rounded-sm';

/** A configuration key, linked to its reference entry. */
function ConfigKey({ name }: { readonly name: string }) {
  return (
    <a href={configKeyDocsUrl(name)} target="_blank" rel="noreferrer" className={LINK}>
      <code className="font-mono text-sm">{name}</code>
    </a>
  );
}

/** Where the held index came from. */
const ORIGIN_TEXT: { readonly [K in NonNullable<SitePackRegistryStatus['index_origin']>]: string } =
  {
    registry: 'Fetched from the registry',
    import: 'Imported from a signed folder',
    local: 'From a signed folder in the local folder',
  };

/** What the last check did, in words. */
function outcomeText(status: SitePackRegistryStatus): string {
  switch (status.last_outcome) {
    case 'updated':
      return 'A newer index verified';
    case 'not_modified':
      return 'Nothing new';
    case 'failed':
      return 'Failed';
    case 'disabled':
      return 'Update check off';
    default:
      return '';
  }
}

/** A time with its relative form, or a word when there is none. */
function When({ at, none }: { readonly at: number | null; readonly none: string }) {
  return at === null ? (
    <span className="text-muted-foreground">{none}</span>
  ) : (
    <RelativeTime at={at} mode="both" />
  );
}

/** A labelled group of facts. */
function FactGroup({
  title,
  items,
  columns = 1,
  children,
}: {
  readonly title: string;
  readonly items: readonly KeyValueItem[];
  readonly columns?: 1 | 2;
  readonly children?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <KeyValue items={items} dividers columns={columns} />
      {children}
    </div>
  );
}

/** A clock difference in words ("about 3h"). */
export function skewText(ms: number): string {
  return `about ${formatDuration(Math.abs(ms)).replace(/ 0+m$/, '')}`;
}

/** The out-of-date index and a failing check, on top of the page; nothing when all is well. */
export function RegistryAlert({ status }: { readonly status: SitePackRegistryStatus }) {
  if (!status.enabled || status.check_off !== null) return null;
  if (status.stale) {
    return (
      <Callout tone="warn" title="The registry index is out of date">
        <p className="text-pretty">
          {status.index_version !== null ? `Index ${status.index_version}` : 'The held index'}{' '}
          expired
          {status.index_expires_at !== null ? (
            <>
              {' '}
              <RelativeTime at={status.index_expires_at} className="min-w-0 text-sm" />
            </>
          ) : null}{' '}
          and no fresh one verified since. Approved packs keep applying; nothing new is downloaded
          from it.
          {status.clock_skew_ms !== undefined
            ? ` The registry’s clock differs from this machine’s by ${skewText(status.clock_skew_ms)}: check the system clock, a wrong clock makes a valid index look expired.`
            : ' Check the network and the registry URL, then press Check now.'}
        </p>
      </Callout>
    );
  }
  if (status.last_outcome === 'failed' && status.failures > 0) {
    return (
      <Callout
        tone={status.failures >= 3 ? 'danger' : 'warn'}
        title={
          status.failures === 1
            ? 'The last update check failed'
            : `The last ${status.failures} update checks failed`
        }
      >
        <p className="text-pretty">
          {status.last_error !== null ? <bdi>{status.last_error.message}</bdi> : null}
          {status.last_error !== null ? ' ' : null}
          Nothing changed: the last good index and every approved pack stay as they were.
          {status.next_check_at !== null ? (
            <>
              {' '}
              BrowserHive tries again{' '}
              <RelativeTime at={status.next_check_at} className="min-w-0 text-sm" />.
            </>
          ) : null}
        </p>
      </Callout>
    );
  }
  return null;
}

/** Why no check runs, inside the card. */
function CheckOffNote({ status }: { readonly status: SitePackRegistryStatus }) {
  if (status.check_off === null || status.check_off === 'packs_off') return null;
  return (
    <Callout
      tone="info"
      title={status.check_off === 'no_trust_root' ? 'No registry trusted yet' : 'Update check off'}
    >
      <p className="text-pretty">
        {CHECK_OFF_TEXT[status.check_off]}{' '}
        {status.check_off === 'update_check_off' ? (
          <>
            Set <ConfigKey name="sitePacksUpdateCheck" /> to true to check browserhive.ai once a
            day.
          </>
        ) : (
          'Bundled packs, local files and signed folders you import still work.'
        )}
      </p>
    </Callout>
  );
}

/** The update check's facts. */
function checkItems(status: SitePackRegistryStatus): KeyValueItem[] {
  const off = status.check_off !== null;
  return [
    {
      key: 'Update check',
      value: (
        <span className="flex flex-col gap-0.5">
          <span>
            {status.check_off === 'no_trust_root'
              ? 'Off: no registry trusted yet'
              : status.update_check
                ? 'On: once a day'
                : 'Off: no request is made'}
          </span>
          <ConfigKey name="sitePacksUpdateCheck" />
        </span>
      ),
    },
    {
      key: 'Registry',
      value:
        status.url === null ? (
          <span className="text-muted-foreground">None</span>
        ) : (
          <span className="font-mono text-sm [overflow-wrap:anywhere]">{status.url}</span>
        ),
    },
    {
      key: 'Last check',
      value: (
        <span className="flex flex-col gap-0.5">
          <When at={status.last_check_at} none={off ? 'None: the check is off' : 'Not yet'} />
          {status.last_check_at !== null && status.last_outcome !== null ? (
            <span className="text-sm text-muted-foreground">{outcomeText(status)}</span>
          ) : null}
        </span>
      ),
    },
    ...(status.last_ok_at !== null && status.last_ok_at !== status.last_check_at
      ? [{ key: 'Last good check', value: <When at={status.last_ok_at} none="Never" /> }]
      : []),
    ...(status.failures > 0
      ? [
          {
            key: 'Failed checks',
            value: (
              <span className="flex flex-col gap-0.5">
                <span>{status.failures} in a row</span>
                {status.last_error !== null ? (
                  <span className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
                    <bdi>{status.last_error.message}</bdi>{' '}
                    <code className="font-mono text-xs">{status.last_error.code}</code>
                  </span>
                ) : null}
              </span>
            ),
          },
        ]
      : []),
    {
      key: 'Next check',
      value: off ? (
        <span className="text-muted-foreground">None</span>
      ) : (
        <When at={status.next_check_at} none="Not scheduled" />
      ),
    },
    {
      key: 'Auto-update',
      value: (
        <span className="flex flex-col gap-0.5">
          <span className="text-pretty">
            {status.auto_update
              ? 'On: followed packs take updates that only tighten rules by themselves'
              : 'Off: every update waits for you'}
          </span>
          <ConfigKey name="sitePacksAutoUpdate" />
        </span>
      ),
    },
  ];
}

/** The held index's facts. */
function indexItems(status: SitePackRegistryStatus): KeyValueItem[] {
  if (status.index_version === null) {
    return [
      { key: 'Index', value: <span className="text-muted-foreground">None verified yet</span> },
      ...(status.keys_version !== null
        ? [{ key: 'Keys version', value: String(status.keys_version) }]
        : []),
    ];
  }
  return [
    {
      key: 'Index',
      value: (
        <span className="flex flex-col gap-0.5">
          <span className="tabular-nums">
            Version {status.index_version} · {status.index_packs}{' '}
            {status.index_packs === 1 ? 'pack' : 'packs'}
          </span>
          {status.index_origin !== null ? (
            <span className="text-sm text-muted-foreground">
              {ORIGIN_TEXT[status.index_origin]}
            </span>
          ) : null}
        </span>
      ),
    },
    { key: 'Issued', value: <When at={status.index_issued_at} none="Unknown" /> },
    {
      key: 'Expires',
      value: (
        <span className={status.stale ? 'text-warn-text' : undefined}>
          <When at={status.index_expires_at} none="Unknown" />
          {status.stale ? <span className="block text-sm">Expired: out of date</span> : null}
        </span>
      ),
    },
    {
      key: 'Signed by',
      value:
        status.index_signed_by === null ? (
          <span className="text-muted-foreground">Unknown</span>
        ) : (
          <span>
            Key <span className="font-mono text-sm">{status.index_signed_by}</span> · signature
            verified
          </span>
        ),
    },
    {
      key: 'Keys version',
      value: status.keys_version === null ? 'Unknown' : String(status.keys_version),
    },
  ];
}

/** What this release and this host bring. */
function hostItems(status: SitePackRegistryStatus): KeyValueItem[] {
  const { local, bundled, snapshot } = status;
  return [
    {
      key: 'Bundled',
      value: `${bundled.count} ${bundled.count === 1 ? 'pack' : 'packs'} with BrowserHive ${bundled.version}`,
    },
    {
      key: 'Release snapshot',
      value:
        snapshot === null ? (
          <span className="text-muted-foreground">None in this release</span>
        ) : (
          <span className="flex flex-col gap-0.5">
            <span>
              Index {snapshot.index_version} ·{' '}
              {snapshot.verified ? 'verified' : 'not verified, not used'}
            </span>
            {snapshot.detail !== null ? (
              <span className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
                <bdi>{snapshot.detail}</bdi>
              </span>
            ) : null}
          </span>
        ),
    },
    {
      key: 'Local folder',
      value: (
        <span className="flex flex-col gap-0.5">
          <span className="font-mono text-sm [overflow-wrap:anywhere]">{local.dir}</span>
          <span className="text-sm text-muted-foreground">
            {local.count} {local.count === 1 ? 'file' : 'files'}
            {local.needing_approval > 0 ? ` · ${local.needing_approval} need approval` : ''}
            {local.signed_layouts > 0
              ? ` · ${local.signed_layouts} signed ${local.signed_layouts === 1 ? 'folder' : 'folders'}`
              : ''}
          </span>
        </span>
      ),
    },
    { key: 'Last loaded', value: <When at={status.last_load_at} none="Not yet" /> },
  ];
}

/** The Registry card. */
export function RegistryCard({
  status,
  picker,
  reload,
}: {
  readonly status: SitePackRegistryStatus;
  readonly picker: ImportPicker;
  /** The Reload local packs button. */
  readonly reload: ReactNode;
}) {
  return (
    <Panel
      title="Registry and sources"
      info={
        <p>
          BrowserHive checks the browserhive.ai registry’s signed index once a day and lists newer
          versions; nothing is downloaded or applied until you say so. Packs bundled with
          BrowserHive and files in the local folder load at start and when you press Reload local
          packs.
        </p>
      }
      infoDocs="sitePacksUpdates"
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <ImportMenu picker={picker} size="sm" />
          {reload}
        </div>
      }
    >
      <div className="flex min-w-0 flex-col gap-6">
        <CheckOffNote status={status} />
        <div className="grid min-w-0 gap-x-10 gap-y-6 lg:grid-cols-2">
          <FactGroup title="Update check" items={checkItems(status)} />
          <div className="flex min-w-0 flex-col gap-6">
            <FactGroup title="Signed index" items={indexItems(status)} />
            <div className="flex min-w-0 gap-3 rounded-lg bg-muted/60 px-4 py-3 text-sm dark:bg-white/[0.03]">
              <ICONS.secured
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0 text-muted-foreground"
              />
              <div className="flex min-w-0 flex-col gap-1">
                <h3 className="font-semibold">What a check sends</h3>
                <p className="text-pretty text-muted-foreground">
                  {CHECK_SENDS} Pack files are fetched only when you press Download & review, which
                  tells the registry which pack you chose, or Download all, which doesn’t.
                </p>
              </div>
            </div>
          </div>
        </div>
        <FactGroup title="This release and this host" items={hostItems(status)} columns={2}>
          <div className="flex flex-wrap gap-x-5 gap-y-1 pt-2 text-sm">
            <a href={docsUrl('sitePacksWriting')} target="_blank" rel="noreferrer" className={LINK}>
              Write a local pack
            </a>
            <a
              href={configKeyDocsUrl('sitePacksDir')}
              target="_blank"
              rel="noreferrer"
              className={LINK}
            >
              Change the local folder (sitePacksDir)
            </a>
          </div>
        </FactGroup>
        {status.skipped.length > 0 ? (
          <div className="flex flex-col gap-2 border-t pt-4">
            <h3 className="text-sm font-semibold">Skipped when loading</h3>
            <ul className="flex flex-col gap-1.5 text-sm">
              {status.skipped.map((s) => (
                <li
                  key={`${s.source}:${s.pack_id}:${s.version ?? 'x'}`}
                  className="min-w-0 [overflow-wrap:anywhere]"
                >
                  <bdi className="font-medium">{s.pack_id}</bdi>
                  {s.version !== null ? ` v${s.version}` : ''} · {SOURCE_LABEL[s.source]}:{' '}
                  {SKIP_REASON_TEXT[s.reason]}
                  {s.detail !== '' ? (
                    <span className="text-muted-foreground">
                      {' '}
                      (<bdi>{s.detail}</bdi>)
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </Panel>
  );
}
