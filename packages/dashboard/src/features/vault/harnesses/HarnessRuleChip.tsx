/** @module features/vault/harnesses/HarnessRuleChip — a rule's harness list as one chip for tables, cards and group headers (D-48): nothing when every harness may fill, a danger chip for an empty list */
import { Chip } from '@/components/shared/Chip.tsx';
import { entryLabel, harnessRuleSummary } from './harness-rule.ts';

/** `harness Claude Code, OpenCode +1`, `no harness: fills blocked`, or nothing (all harnesses). */
export function HarnessRuleChip({
  harnesses,
}: {
  readonly harnesses?: readonly string[] | null | undefined;
}) {
  const summary = harnessRuleSummary(harnesses);
  if (summary === null || harnesses === null || harnesses === undefined) return null;
  if (harnesses.length === 0) return <Chip tone="danger">no harness: fills blocked</Chip>;
  return (
    <Chip tone="vault" className="min-w-0" title={`Only ${harnesses.map(entryLabel).join(', ')}`}>
      <span className="opacity-75">harness</span>
      <span className="truncate">{summary}</span>
    </Chip>
  );
}
