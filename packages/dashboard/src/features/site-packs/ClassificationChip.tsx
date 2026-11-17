/** @module features/site-packs/ClassificationChip — a classification as a chip: icon and words, never colour alone (spec 13 §11.4, spec 04 §1); used on pending versions, diffs and history rows */
import type { SitePackClassification } from '@browserhive/contracts/http';
import { Chip } from '@/components/shared/Chip.tsx';
import { iconFor } from '@/lib/icons.ts';
import { cn } from '@/lib/utils.ts';
import { CLASSIFICATION_INFO } from './classification.ts';

/** The chip. */
export function ClassificationChip({
  classification,
  className,
}: {
  readonly classification: SitePackClassification;
  readonly className?: string;
}) {
  const info = CLASSIFICATION_INFO[classification];
  const Icon = iconFor(info.icon);
  return (
    <Chip tone={info.tone} data-classification={classification} className={cn('gap-1', className)}>
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      {info.label}
    </Chip>
  );
}
