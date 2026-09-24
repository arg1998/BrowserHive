/** @module features/harness/ClientPanel — the session detail's "Client" panel (spec 04 §12.3, D-30): the launch harness and how it was recognised, the declared model ("not reported" when absent) and workspace, `clientInfo`, protocol version and the capped meta bag, under one self-reported explainer */
import type { SessionSummary } from '@browserhive/contracts/http';
import { KeyValue, type KeyValueItem } from '@/components/shared/KeyValue.tsx';
import { Panel } from '@/components/shared/Section.tsx';
import {
  declaredSourcePhrase,
  harnessLabel,
  harnessSourcePhrase,
  isUnknownHarness,
} from '@/lib/harness.ts';
import { HarnessName, selfReportedExplainer } from './HarnessName.tsx';

function Muted({ children }: { readonly children: string }) {
  return <span className="text-muted-foreground">{children}</span>;
}

/** Harness label, its slug when the label differs, and how it was recognised. */
export function HarnessValue({
  harness,
  source,
}: {
  readonly harness: string;
  readonly source: string | null | undefined;
}) {
  const label = harnessLabel(harness);
  return (
    <span className="inline-flex max-w-full flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <HarnessName harness={harness} className="font-medium" />
      {!isUnknownHarness(harness) && label !== harness ? (
        <span className="font-mono text-sm text-muted-foreground">{harness}</span>
      ) : null}
      <span className="text-sm text-muted-foreground">{harnessSourcePhrase(source)}</span>
    </span>
  );
}

/** Rows of a meta bag, keys in mono. */
export function metaItems(meta: Readonly<Record<string, string>> | undefined): KeyValueItem[] {
  return Object.entries(meta ?? {}).map(([key, value]) => ({ key, value, mono: true }));
}

/** The panel. */
export function ClientPanel({ session }: { readonly session: SessionSummary }) {
  const client = session.client;
  const items: KeyValueItem[] = [
    {
      key: 'Harness',
      value: (
        <HarnessValue
          harness={session.harness}
          source={client?.harness_source ?? (client === null ? null : 'none')}
        />
      ),
    },
  ];
  if (client !== null) {
    const modelSource = declaredSourcePhrase(client.model_source);
    items.push(
      {
        key: 'Model',
        value:
          client.model === undefined ? (
            <Muted>not reported</Muted>
          ) : (
            <span className="inline-flex flex-wrap items-baseline gap-x-2">
              <span>{client.model}</span>
              {modelSource !== null ? <Muted>{modelSource}</Muted> : null}
            </span>
          ),
      },
      {
        key: 'Workspace',
        value: client.workspace ?? client.agent_name ?? <Muted>—</Muted>,
      },
      {
        key: 'Client',
        value:
          client.name === null && client.version === null ? (
            <Muted>not reported</Muted>
          ) : (
            [client.name, client.version].filter((v) => v !== null).join(' ') +
            (client.title !== undefined && client.title !== client.name ? ` (${client.title})` : '')
          ),
      },
    );
    if (client.protocol_version !== undefined) {
      items.push({ key: 'Protocol', value: client.protocol_version });
    }
  }
  const meta = metaItems(client?.meta);
  return (
    <Panel title="Client" info={selfReportedExplainer()} infoDocs="harnessIdentity">
      <div className="flex flex-col gap-4">
        <KeyValue items={items} />
        {client === null ? (
          <p className="text-sm text-muted-foreground">
            No client details were recorded for this session.
          </p>
        ) : null}
        {meta.length > 0 ? (
          <section aria-label="Meta" className="flex flex-col gap-2 border-t pt-3">
            <h3 className="section-label">Meta</h3>
            <KeyValue items={meta} />
          </section>
        ) : null}
      </div>
    </Panel>
  );
}
