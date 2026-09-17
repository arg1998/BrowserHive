/** @module features/attention/AttentionPage — `/attention`, the human-in-the-loop queue: header (open count badge, one explainer, labelled sound toggle), the open requests board (attention + vault confirms), settled history (spec 04 §12.4) */
import { useTopic } from '@/app/providers/SocketProvider.tsx';
import { DataPanel } from '@/components/shared/DataPanel.tsx';
import { PageHeader } from '@/components/shared/PageHeader.tsx';
import { Section } from '@/components/shared/Section.tsx';
import { SkeletonCard } from '@/components/shared/Skeletons.tsx';
import { TonePill } from '@/components/shared/StatusBadge.tsx';
import { Switch } from '@/components/ui/switch.tsx';
import { Hint } from '@/components/ui/tooltip.tsx';
import { useVaultConfirms, useVaultEnabled } from '@/features/vault/api.ts';
import { formatNumber } from '@/lib/format/bytes.ts';
import { ICONS } from '@/lib/icons.ts';
import { useSearchState } from '@/lib/search/use-search-state.ts';
import { useAttentionPending } from './api.ts';
import { HistoryTable } from './HistoryTable.tsx';
import { LiveBoard } from './LiveBoard.tsx';
import { ModeExplainer } from './ModeExplainer.tsx';
import type { AttentionSearch } from './search.ts';
import { useRequestAlerts, useSoundPreference } from './use-request-alerts.ts';

/** Sound alert toggle: a clickable label with an explanation tooltip. */
function SoundToggle({
  enabled,
  onChange,
}: {
  readonly enabled: boolean;
  readonly onChange: (next: boolean) => void;
}) {
  const Icon = enabled ? ICONS.sound : ICONS.soundOff;
  return (
    <Hint label="Play a short chime when a new request arrives. Saved on this device only.">
      {/* biome-ignore lint/a11y/noLabelWithoutControl: the Switch inside is the labelled control (label wraps it, so the text toggles it) */}
      <label className="flex h-9 cursor-pointer items-center gap-2.5 rounded-md border bg-card px-3 text-sm font-medium shadow-xs select-none hover:bg-accent/70 dark:shadow-none dark:hover:bg-white/[0.035]">
        <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        Sound alerts
        <Switch size="sm" checked={enabled} onCheckedChange={(next) => onChange(next)} />
      </label>
    </Hint>
  );
}

/** Attention page. */
export function AttentionPage() {
  const { search } = useSearchState<AttentionSearch>();
  const pending = useAttentionPending();
  const vaultEnabled = useVaultEnabled() === true;
  const confirms = useVaultConfirms(vaultEnabled);
  const [sound, setSound] = useSoundPreference();
  useTopic('attention');
  useTopic(vaultEnabled ? 'vault.confirm' : null);
  useRequestAlerts(sound);
  const openCount = pending.data?.open_count ?? pending.data?.data.length ?? 0;
  const confirmRows = confirms.data?.data ?? [];
  const bySession = (rows: typeof confirmRows) =>
    search.session === undefined ? rows : rows.filter((r) => r.session_id === search.session);
  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Attention"
        badge={
          openCount > 0 ? (
            <TonePill entry={{ label: `${formatNumber(openCount)} open`, tone: 'warn' }} pulse />
          ) : undefined
        }
        description="Agents that called request_attention wait here, their lease frozen, until you decide."
        learnMore={<ModeExplainer mode={null} />}
        learnMoreDocs="attention"
        actions={<SoundToggle enabled={sound} onChange={setSound} />}
      />
      <DataPanel query={pending} skeleton={<SkeletonCard />} isEmpty={() => false} empty={null}>
        {(data) => (
          <LiveBoard
            pending={bySession(data.data)}
            confirms={bySession(confirmRows)}
            vaultEnabled={vaultEnabled}
          />
        )}
      </DataPanel>
      <Section
        title="History"
        description="Settled requests: resolved, rejected, timed out or cancelled"
      >
        <HistoryTable />
      </Section>
    </div>
  );
}
