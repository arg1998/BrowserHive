/** @module app/shell/CommandPalette — 640px palette: combobox + grouped listbox (`aria-activedescendant`), entity search (sessions, attention), page actions, keyboard hints */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { RelativeTime } from '@/components/shared/RelativeTime.tsx';
import { TONE_CLASSES } from '@/components/shared/tones.ts';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog.tsx';
import { Kbd } from '@/components/ui/kbd.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { ICONS } from '@/lib/icons.ts';
import { cn } from '@/lib/utils.ts';
import { usePageActionsList } from './page-actions.tsx';
import {
  matchesQuery,
  PALETTE_GROUPS,
  type PaletteCommand,
  pushRecent,
  readRecent,
  usePaletteCommands,
} from './use-palette-commands.ts';

export type { PaletteCommand } from './use-palette-commands.ts';
export { matchesQuery } from './use-palette-commands.ts';

/** Props. */
export interface CommandPaletteProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

/** Commands visible for a query, in render order (pure; exported for tests). */
export function visibleCommands(
  commands: readonly PaletteCommand[],
  query: string,
  recent: readonly string[],
): readonly PaletteCommand[] {
  const matched = commands.filter((c) => c.serverMatched === true || matchesQuery(c, query));
  const ordered = PALETTE_GROUPS.flatMap((group) => matched.filter((c) => c.group === group));
  if (query.trim() !== '') return ordered;
  const recents = recent
    .map((id) => commands.find((c) => c.id === id && c.group !== 'Attention'))
    .filter((c): c is PaletteCommand => c !== undefined)
    .map((c) => ({ ...c, group: 'Recent' as const, id: `recent:${c.id}` }));
  return [...recents, ...ordered];
}

/** Palette. */
export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [active, setActive] = useState(0);
  const [recent, setRecent] = useState<readonly string[]>(() => readRecent());
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const pageActions = usePageActionsList();

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setDebounced('');
    setActive(0);
    setRecent(readRecent());
  }, [open]);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 150);
    return () => clearTimeout(timer);
  }, [query]);

  const { commands, searching } = usePaletteCommands(open, debounced, pageActions);
  const visible = useMemo(
    () => visibleCommands(commands, query, recent),
    [commands, query, recent],
  );

  useEffect(() => {
    if (active >= visible.length) setActive(0);
  }, [active, visible.length]);

  const run = (command: PaletteCommand) => {
    setRecent(pushRecent(recent, command.id.replace(/^recent:/, '')));
    onOpenChange(false);
    command.run();
  };

  const activeCommand = visible[active];
  const activeId = activeCommand === undefined ? undefined : `${listId}-${activeCommand.id}`;
  useEffect(() => {
    if (activeId === undefined) return;
    const node = listRef.current?.ownerDocument.getElementById(activeId);
    node?.scrollIntoView?.({ block: 'nearest' });
  }, [activeId]);

  const SearchIcon = ICONS.search;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="top-[12dvh] flex max-h-[min(36rem,76dvh)] translate-y-0 flex-col gap-0 overflow-hidden p-0 sm:max-w-160"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <div className="flex h-14 shrink-0 items-center gap-3 border-b px-4">
          <SearchIcon aria-hidden="true" className="size-4.5 shrink-0 text-muted-foreground" />
          <input
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={activeId}
            aria-autocomplete="list"
            aria-label="Search sessions, attention requests, pages and actions"
            autoFocus
            className="h-full min-w-0 flex-1 bg-transparent text-md outline-none placeholder:text-subtle-foreground"
            placeholder="Search sessions, pages, actions…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActive((a) => (visible.length === 0 ? 0 : (a + 1) % visible.length));
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActive((a) =>
                  visible.length === 0 ? 0 : (a - 1 + visible.length) % visible.length,
                );
              } else if (event.key === 'Enter') {
                event.preventDefault();
                if (activeCommand !== undefined) run(activeCommand);
              }
            }}
          />
          {searching ? <Spinner className="size-4 text-muted-foreground" /> : null}
          <Kbd className="hidden sm:inline-flex">Esc</Kbd>
        </div>
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label="Results"
          className="min-h-0 flex-1 overflow-y-auto p-2"
        >
          {visible.length === 0 ? (
            <div className="flex flex-col items-center gap-1 px-4 py-10 text-center">
              <p className="text-base font-medium">No results</p>
              <p className="text-sm text-muted-foreground">
                {query.trim().length === 1
                  ? 'Type at least two characters to search sessions.'
                  : 'Try a session slug, an id, or a page name.'}
              </p>
            </div>
          ) : null}
          {PALETTE_GROUPS.map((group) => {
            const members = visible.filter((c) => c.group === group);
            if (members.length === 0) return null;
            return (
              // biome-ignore lint/a11y/useSemanticElements: ARIA group inside a custom listbox (combobox pattern)
              <div key={group} role="group" aria-label={group} className="mb-1 last:mb-0">
                <p className="px-2 pt-2 pb-1.5 text-xs font-medium text-muted-foreground">
                  {group}
                </p>
                {members.map((command) => {
                  const index = visible.indexOf(command);
                  const Icon = ICONS[command.icon];
                  const selected = index === active;
                  return (
                    <div
                      key={command.id}
                      id={`${listId}-${command.id}`}
                      role="option"
                      tabIndex={-1}
                      aria-selected={selected}
                      className={cn(
                        'flex h-10 cursor-pointer items-center gap-3 rounded-md px-2.5 text-base',
                        selected && 'bg-accent text-accent-foreground',
                      )}
                      onMouseMove={() => {
                        if (!selected) setActive(index);
                      }}
                      onClick={() => run(command)}
                      onKeyDown={(event) => (event.key === 'Enter' ? run(command) : undefined)}
                    >
                      <Icon
                        aria-hidden="true"
                        className={cn(
                          'size-4 shrink-0',
                          selected ? 'text-foreground' : 'text-muted-foreground',
                        )}
                      />
                      <span className="min-w-0 flex-1 truncate">{command.label}</span>
                      {command.status !== undefined ? (
                        // Entity rows: fixed columns so same-slug sessions line up.
                        <span className="hidden w-24 shrink-0 items-center gap-1.5 text-sm text-muted-foreground sm:flex">
                          <span
                            aria-hidden="true"
                            className={cn(
                              'size-2 shrink-0 rounded-full',
                              TONE_CLASSES[command.status.tone].dot,
                            )}
                          />
                          <span className="truncate">{command.status.label}</span>
                        </span>
                      ) : null}
                      {command.hint !== undefined ? (
                        <span
                          className={cn(
                            'shrink truncate text-sm text-muted-foreground',
                            command.monoHint === true && 'font-mono',
                            command.status !== undefined ? 'w-44 max-w-[40%]' : 'max-w-[40%]',
                          )}
                        >
                          {command.hint}
                        </span>
                      ) : null}
                      {command.at !== undefined ? (
                        <RelativeTime
                          at={command.at}
                          className="hidden w-20 shrink-0 justify-end text-right text-sm text-muted-foreground sm:inline-flex"
                        />
                      ) : null}
                      <ICONS.enter
                        aria-hidden="true"
                        className={cn(
                          'size-3.5 shrink-0 text-muted-foreground',
                          !selected && 'invisible',
                        )}
                      />
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
        <div className="flex h-10 shrink-0 items-center gap-4 border-t px-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> to navigate
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>↵</Kbd> to open
          </span>
          <span className="ml-auto hidden items-center gap-1.5 sm:flex">
            <Kbd>?</Kbd> all shortcuts
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
