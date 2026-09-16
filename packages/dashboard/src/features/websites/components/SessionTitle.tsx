/** @module features/websites/components/SessionTitle — a session's slug as the title of a linked row: one truncating line that underlines on row hover, full slug and id in a tooltip (no copy control: the row itself opens the session) */
import { Hint } from '@/components/ui/tooltip.tsx';
import { sessionSlug } from '@/lib/format/ids.ts';
import { cn } from '@/lib/utils.ts';

/** Props. */
export interface SessionTitleProps {
  readonly id: string;
  readonly slug?: string | null;
  readonly className?: string;
}

/** Session title for linked rows. */
export function SessionTitle({ id, slug, className }: SessionTitleProps) {
  const label = slug ?? sessionSlug(id);
  return (
    <Hint label={<span className="font-mono">{id}</span>}>
      <span
        className={cn(
          'block min-w-0 truncate font-medium text-foreground decoration-muted-foreground/60 underline-offset-4 group-hover/row:underline',
          className,
        )}
      >
        {label}
      </span>
    </Hint>
  );
}
