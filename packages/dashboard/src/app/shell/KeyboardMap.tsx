/** @module app/shell/KeyboardMap — the `?` sheet: global shortcuts and Esc, table keys on pages with a table, and whatever the current page registers, grouped, with platform-correct labels */
import { useMemo } from 'react';
import { useShortcutList } from '@/app/providers/KeyboardProvider.tsx';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.tsx';
import { Kbd } from '@/components/ui/kbd.tsx';
import { formatCombo, type Shortcut } from '@/lib/keyboard.ts';
import { isMacLike } from './platform.ts';

export { isMacLike } from './platform.ts';

/** A documented shortcut. `combos` lists alternatives ("J / K or ↓ / ↑"); each is a key sequence shown as "A / B". */
export interface ShortcutDoc {
  readonly id: string;
  readonly combos: readonly (readonly string[])[];
  readonly description: string;
  readonly group: string;
}

const TABLES = 'Lists and tables';

/** Keys handled inside `DataTable` rather than registry entries (kept in sync with `DataTable`). */
export const TABLE_SHORTCUTS: readonly ShortcutDoc[] = [
  {
    id: 'table.move',
    combos: [
      ['j', 'k'],
      ['arrowdown', 'arrowup'],
    ],
    description: 'Next / previous row',
    group: TABLES,
  },
  { id: 'table.ends', combos: [['home', 'end']], description: 'First / last row', group: TABLES },
  { id: 'table.open', combos: [['enter']], description: 'Open the focused row', group: TABLES },
  {
    id: 'table.select',
    combos: [['x'], ['space']],
    description: 'Select the focused row',
    group: TABLES,
  },
  {
    id: 'table.menu',
    combos: [['shift+f10'], ['.']],
    description: 'Actions for the focused row',
    group: TABLES,
  },
];

/** Esc is handled by every overlay; listed once so it is always discoverable. */
const ESCAPE: ShortcutDoc = {
  id: 'overlay.close',
  combos: [['escape']],
  description: 'Close the topmost overlay or clear a search',
  group: 'General',
};

/** Registry ids that are plumbing, not something to learn (Esc is documented once instead). */
const HIDDEN = new Set(['overlay.close', 'sidebar.peek.close']);
const GROUP_ORDER = ['General', 'Navigation', TABLES, 'Page'];

/**
 * Registered shortcuts plus the always-true ones, grouped and ordered (pure; exported for tests).
 * Page shortcuts appear only while their page registers them; table keys only when the page shows a
 * table (`tables`).
 */
export function shortcutSections(
  registered: readonly Shortcut[],
  options: { readonly tables?: boolean } = {},
): readonly (readonly [string, readonly ShortcutDoc[]])[] {
  const docs = new Map<string, ShortcutDoc>();
  for (const s of registered) {
    if (HIDDEN.has(s.id) || docs.has(s.id)) continue;
    docs.set(s.id, {
      id: s.id,
      combos: [[s.combo]],
      description: s.description,
      group: s.group ?? 'Page',
    });
  }
  docs.set(ESCAPE.id, ESCAPE);
  if (options.tables === true) for (const doc of TABLE_SHORTCUTS) docs.set(doc.id, doc);
  const groups = new Map<string, ShortcutDoc[]>();
  for (const doc of docs.values()) groups.set(doc.group, [...(groups.get(doc.group) ?? []), doc]);
  const rank = (g: string) => {
    const i = GROUP_ORDER.indexOf(g);
    return i === -1 ? GROUP_ORDER.length : i;
  };
  return [...groups.entries()].sort((a, b) => rank(a[0]) - rank(b[0]));
}

/** Does the current page show a keyboard-navigable table? */
function pageHasTable(): boolean {
  return document.querySelector('#main table[data-slot="table"]') !== null;
}

/** Shortcut sheet. */
export function KeyboardMap({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const shortcuts = useShortcutList();
  const mac = isMacLike();
  // Evaluated when the sheet opens: table keys are listed only on pages that have a table.
  const sections = useMemo(
    () => shortcutSections(shortcuts, { tables: open && pageHasTable() }),
    [shortcuts, open],
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Shortcuts don't fire while you type in a field. Page shortcuts are listed while you are
            on that page.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="grid grid-cols-1 gap-x-10 gap-y-6 pb-1 md:grid-cols-2">
            {sections.map(([group, list]) => (
              <section key={group} aria-label={group} className="flex flex-col gap-1">
                <h3 className="pb-1 text-sm font-medium text-muted-foreground">{group}</h3>
                <dl className="flex flex-col">
                  {list.map((s) => (
                    <div
                      key={s.id}
                      className="flex min-h-9 items-center justify-between gap-4 border-b last:border-b-0"
                    >
                      <dt className="text-base">{s.description}</dt>
                      <dd className="flex shrink-0 items-center gap-1.5">
                        {s.combos.map((keys, group) => (
                          <span key={keys.join(' ')} className="flex items-center gap-1">
                            {group > 0 ? (
                              <span className="pr-0.5 text-xs text-muted-foreground">or</span>
                            ) : null}
                            {keys.map((combo, index) => (
                              <span key={combo} className="flex items-center gap-1">
                                {index > 0 ? (
                                  <span
                                    aria-hidden="true"
                                    className="text-xs text-muted-foreground"
                                  >
                                    /
                                  </span>
                                ) : null}
                                <Kbd>{formatCombo(combo, mac)}</Kbd>
                              </span>
                            ))}
                          </span>
                        ))}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
