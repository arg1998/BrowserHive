/** @module features/system/config/ConfigSection — System › Configuration: the settings in effect grouped for reading (server, sessions, stealth, integrations), then every key with its provenance */
import type { SystemConfigResponse, SystemInfo } from '@browserhive/contracts/http';
import type { UseQueryResult } from '@tanstack/react-query';
import { DataPanel } from '@/components/shared/DataPanel.tsx';
import { EmptyState } from '@/components/shared/EmptyState.tsx';
import { Panel } from '@/components/shared/Section.tsx';
import { SkeletonKv } from '@/components/shared/Skeletons.tsx';
import { SettingsList } from '../components/SettingsList.tsx';
import { settingsGroups } from '../model.ts';
import { ConfigTable } from './ConfigTable.tsx';

/** Settings groups per column on wide screens (one column below `lg`, in this order). */
const CONFIG_COLUMNS = [
  ['server', 'integrations'],
  ['sessions', 'stealth'],
] as const;

/** Props. */
export interface ConfigSectionProps {
  readonly system: SystemInfo;
  readonly config: UseQueryResult<SystemConfigResponse, unknown>;
  readonly filter: string | undefined;
  readonly onFilterChange: (value: string | undefined) => void;
}

/** Configuration section. */
export function ConfigSection({ system, config, filter, onFilterChange }: ConfigSectionProps) {
  const groups = settingsGroups(system);
  return (
    <div className="flex flex-col gap-6">
      {/* Two independent stacks, never equal-height rows: what the daemon is attached to (server,
          integrations) beside how its browsers behave (sessions, stealth). No empty panel bottoms. */}
      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
        {CONFIG_COLUMNS.map((column) => (
          <div key={column.join()} className="flex min-w-0 flex-col gap-6">
            {column.map((id) => {
              const group = groups.find((g) => g.id === id);
              return group === undefined ? null : (
                <Panel key={group.id} title={group.title} bodyClassName="px-5 pt-1 pb-2">
                  <SettingsList rows={group.rows} label={group.title} />
                </Panel>
              );
            })}
          </div>
        ))}
      </div>
      <Panel
        title="All configuration keys"
        info={
          <>
            <p>
              Every key can be set as a flag, in <code>browserhive.config.json</code> or as a{' '}
              <code>BROWSERHIVE_*</code> environment variable; the rightmost source wins. Values
              another source overrode are listed as shadowed.
            </p>
            <p>Unknown keys fail startup instead of being ignored.</p>
          </>
        }
        infoDocs="configurationPrecedence"
        description="The effective value of every key and where it came from: cli › file › env › default. Secrets are never shown."
        padding="none"
      >
        <DataPanel
          query={config}
          skeleton={
            <div className="px-5 pb-5">
              <SkeletonKv count={8} />
            </div>
          }
          isEmpty={(d) => d.keys.length === 0}
          empty={<EmptyState kind="zero-data" title="No configuration reported" size="sm" />}
        >
          {(data) => (
            <ConfigTable keys={data.keys} filter={filter} onFilterChange={onFilterChange} />
          )}
        </DataPanel>
      </Panel>
    </div>
  );
}
