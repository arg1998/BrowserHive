/** @module features/system/SystemPage — `/system` in three URL-addressed sections (`?tab`): Status (live health and metrics), Agent tokens, Configuration (settings in effect and every key with provenance); one page-level 403 for a principal without `system:read`; live via the `system` topic, no polling (spec 04 §12.10) */
import { useMemo, useState } from 'react';
import { useTopic } from '@/app/providers/SocketProvider.tsx';
import { DataPanel } from '@/components/shared/DataPanel.tsx';
import { ErrorState } from '@/components/shared/ErrorState.tsx';
import { PageHeader } from '@/components/shared/PageHeader.tsx';
import { SkeletonKv, SkeletonTiles } from '@/components/shared/Skeletons.tsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs.tsx';
import { toAppError } from '@/lib/api/errors.ts';
import { useSearchState } from '@/lib/search/use-search-state.ts';
import {
  MCP_CONNECTION_PAGE_SIZE_DEFAULT,
  type McpConnectionPageSize,
  type McpConnectionsPaging,
} from '../harness/McpConnectionsPanel.tsx';
import {
  isForbiddenError,
  useConfig,
  useHealth,
  useMcpConnections,
  useRealtime,
  useSystem,
  useSystemEvents,
} from './api.ts';
import { ConfigSection } from './config/ConfigSection.tsx';
import { readHealth } from './model.ts';
import {
  SYSTEM_SECTION_LABEL,
  SYSTEM_SECTIONS,
  type SystemSearch,
  systemSection,
} from './search.ts';
import { StatusSection } from './status/StatusSection.tsx';
import { TokensSection } from './tokens/TokensSection.tsx';

/** System. */
export function SystemPage() {
  const { search, set } = useSearchState<SystemSearch>();
  const tab = systemSection(search.tab);
  const system = useSystem();
  const forbidden = isForbiddenError(system.error);
  const status = tab === 'status' && !forbidden;
  const realtime = useRealtime(status);
  const [mcpPage, setMcpPage] = useState(1);
  const [mcpPageSize, setMcpPageSize] = useState<McpConnectionPageSize>(
    MCP_CONNECTION_PAGE_SIZE_DEFAULT,
  );
  const mcpPaging = useMemo<McpConnectionsPaging>(
    () => ({
      page: mcpPage,
      pageSize: mcpPageSize,
      onPage: setMcpPage,
      onPageSize: (size) => {
        setMcpPageSize(size);
        setMcpPage(1);
      },
    }),
    [mcpPage, mcpPageSize],
  );
  const mcpConnections = useMcpConnections(status, { page: mcpPage, pageSize: mcpPageSize });
  const events = useSystemEvents(status);
  const health = useHealth(status);
  const config = useConfig(tab === 'config' && !forbidden);
  useTopic(forbidden ? null : 'system');

  const header = (
    <PageHeader
      title="System"
      description="Daemon health, agent access and the configuration in effect."
      learnMore={
        <>
          <p>
            <b>Status</b> shows health checks, capacity, storage and the defaults new sessions get.
            <b> Agent tokens</b> are the bearer tokens MCP clients use when agent authentication is
            on. <b>Configuration</b> lists every effective setting with where it came from.
          </p>
          <p>
            Settings are read at startup, from flags, <code>browserhive.config.json</code> and
            environment variables; change them there and restart.
          </p>
        </>
      }
      learnMoreDocs="configuration"
      {...(!forbidden && {
        tabs: (
          <TabsList aria-label="System sections">
            {SYSTEM_SECTIONS.map((section) => (
              <TabsTrigger key={section} value={section}>
                {SYSTEM_SECTION_LABEL[section]}
              </TabsTrigger>
            ))}
          </TabsList>
        ),
      })}
    />
  );

  if (forbidden) {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <ErrorState
          tier="page"
          title="System is for operators"
          error={toAppError(system.error)}
          escape={{ label: 'Go to Overview', to: '/overview' }}
        />
      </div>
    );
  }

  return (
    <Tabs
      value={tab}
      onValueChange={(value) => set({ tab: systemSection(value), key: undefined })}
      className="gap-6"
    >
      {header}
      <TabsContent value="status">
        <DataPanel
          query={system}
          skeleton={
            <div className="flex flex-col gap-6">
              <SkeletonTiles
                count={5}
                className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5"
                tileClassName={(i) =>
                  i === 0
                    ? 'col-span-2 md:col-span-1'
                    : i === 4
                      ? 'md:col-span-2 xl:col-span-1'
                      : undefined
                }
              />
              <SkeletonKv count={6} />
            </div>
          }
          isEmpty={() => false}
          empty={null}
          errorVariant="panel"
        >
          {(s) => (
            <StatusSection
              system={s}
              health={readHealth(health.data, health.error)}
              healthQuery={health}
              events={events.data?.data ?? s.degradations}
              realtime={realtime}
              mcpConnections={mcpConnections}
              mcpPaging={mcpPaging}
            />
          )}
        </DataPanel>
      </TabsContent>
      <TabsContent value="tokens">
        <TokensSection
          authMode={system.data?.auth_mode}
          daemon={
            system.data === undefined
              ? undefined
              : { host: system.data.host, port: system.data.port }
          }
        />
      </TabsContent>
      <TabsContent value="config">
        <DataPanel
          query={system}
          skeleton={<SkeletonKv count={8} />}
          isEmpty={() => false}
          empty={null}
          errorVariant="panel"
        >
          {(s) => (
            <ConfigSection
              system={s}
              config={config}
              filter={search.key}
              onFilterChange={(key) => set({ key })}
            />
          )}
        </DataPanel>
      </TabsContent>
    </Tabs>
  );
}
