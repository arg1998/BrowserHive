/** @module components/shared/ColumnMenu — the table "View" menu: row density and column visibility (priority-1 columns are never hidden) */
import { Button } from '@/components/ui/button.tsx';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx';
import { ICONS } from '@/lib/icons.ts';
import type { DataTableColumn } from './use-data-table.ts';
import { type Density, useDensity } from './use-density.ts';

/** Props. */
export interface ColumnMenuProps<Row> {
  readonly columns?: readonly DataTableColumn<Row>[];
  readonly hidden?: ReadonlySet<string>;
  readonly onHiddenChange?: (hidden: ReadonlySet<string>) => void;
  readonly className?: string;
}

const EMPTY: ReadonlySet<string> = new Set();

/** View menu (density + columns). Place it in the page's filter toolbar. */
export function ColumnMenu<Row>({
  columns = [],
  hidden = EMPTY,
  onHiddenChange,
  className,
}: ColumnMenuProps<Row>) {
  const [density, setDensity] = useDensity();
  const View = ICONS.densityComfortable;
  const hideable = onHiddenChange === undefined ? [] : columns.filter((c) => c.priority !== 1);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button type="button" variant="outline" size="sm" className={className} />}
      >
        <View aria-hidden="true" /> View
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Density</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={density}
            onValueChange={(value: unknown) =>
              setDensity(value === 'compact' ? 'compact' : ('comfortable' satisfies Density))
            }
          >
            <DropdownMenuRadioItem value="comfortable">
              <ICONS.densityComfortable aria-hidden="true" /> Comfortable
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="compact">
              <ICONS.densityCompact aria-hidden="true" /> Compact
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        {hideable.length > 0 && onHiddenChange !== undefined ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>Columns</DropdownMenuLabel>
              {hideable.map((column) => (
                <DropdownMenuCheckboxItem
                  key={column.id}
                  checked={!hidden.has(column.id)}
                  onCheckedChange={(checked) => {
                    const next = new Set(hidden);
                    if (checked) next.delete(column.id);
                    else next.add(column.id);
                    onHiddenChange(next);
                  }}
                >
                  {column.header}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuGroup>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
