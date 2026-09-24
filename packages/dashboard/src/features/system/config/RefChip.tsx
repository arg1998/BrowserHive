/** @module features/system/config/RefChip — the environment variable behind a config-file value (`{env:NAME}`, spec 08 §3.1): a mono `$NAME` chip that opens a popover with whether the variable was set, where it is used and, for keys that are not secret, the value as written in browserhive.config.json */
import type { SystemConfigRef } from '@browserhive/contracts/http';
import { TONE_CLASSES } from '@/components/shared/tones.ts';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.tsx';
import { ICONS } from '@/lib/icons.ts';
import { docsUrl } from '@/lib/links.ts';
import { cn } from '@/lib/utils.ts';

/** One variable of a row: its name, whether the default was used, and every position it fills. */
export interface RowRef {
  readonly name: string;
  readonly from: SystemConfigRef['from'];
  readonly at: readonly string[];
}

/**
 * The variables of a value, once each, in source order (a variable used twice appears once, with
 * every position it fills).
 *
 * @returns The variables.
 */
export function rowRefs(refs: readonly SystemConfigRef[] | undefined): readonly RowRef[] {
  const byName = new Map<string, { from: SystemConfigRef['from']; at: string[] }>();
  for (const ref of refs ?? []) {
    const entry = byName.get(ref.ref) ?? { from: ref.from, at: [] };
    if (ref.at !== undefined && !entry.at.includes(ref.at)) entry.at.push(ref.at);
    byName.set(ref.ref, entry);
  }
  return [...byName].map(([name, entry]) => ({ name, from: entry.from, at: entry.at }));
}

const REF_TEXT = /(\{env:[A-Za-z_][A-Za-z0-9_]*(?::-[^{}]*)?\})/;

/** The value as written, with every reference picked out in the variable hue. */
function Template({ text }: { readonly text: string }) {
  const parts = text.split(REF_TEXT);
  return (
    <code className="block rounded-md bg-muted px-2 py-1.5 font-mono text-[0.8125rem] leading-normal text-foreground [overflow-wrap:anywhere] whitespace-pre-wrap dark:bg-white/[0.06]">
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts of one immutable string, never reordered
          <span key={index} className={cn('font-medium', TONE_CLASSES.vault.text)}>
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </code>
  );
}

/** Props. */
export interface RefChipProps {
  readonly configKey: string;
  readonly refInfo: RowRef;
  /** The value as written in the file; absent for secret keys. */
  readonly template: string | undefined;
  readonly secret: boolean;
}

/** `$NAME` chip with its popover. */
export function RefChip({ configKey, refInfo, template, secret }: RefChipProps) {
  const External = ICONS.external;
  const fellBack = refInfo.from === 'default';
  const state = fellBack ? 'not set, so the default written in the file is used' : 'set';
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={`$${refInfo.name}: environment variable, ${state}. Show details`}
            title={`$${refInfo.name}`}
            className={cn(
              'relative inline-flex h-5.5 max-w-full cursor-pointer items-center rounded-md px-1.5 font-mono text-xs font-medium whitespace-nowrap transition-colors duration-(--duration-fast) focus-ring',
              // A 40px touch target without growing the row.
              'after:absolute after:-inset-y-2 after:inset-x-0',
              fellBack
                ? 'border border-dashed border-vault-border text-vault-text hover:bg-vault-bg data-popup-open:bg-vault-bg'
                : cn(
                    TONE_CLASSES.vault.soft,
                    'hover:brightness-95 data-popup-open:brightness-95 dark:hover:brightness-125 dark:data-popup-open:brightness-125',
                  ),
            )}
          />
        }
      >
        <span className="truncate">${refInfo.name}</span>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="end"
        className="w-80 max-w-[calc(100vw-2rem)] gap-0 p-0 text-popover-foreground"
      >
        <div className="flex flex-col gap-3 px-4 pt-3.5 pb-4">
          <div className="flex flex-col gap-0.5">
            <p className="font-mono text-sm font-semibold text-foreground [overflow-wrap:anywhere]">
              ${refInfo.name}
            </p>
            <p className="text-sm text-muted-foreground">
              Environment variable, read by{' '}
              <code className="font-mono text-foreground">{configKey}</code>
              {fellBack ? (
                <>
                  . <b className="font-semibold text-foreground">Not set</b>, so the default written
                  in the file is used.
                </>
              ) : (
                '.'
              )}
            </p>
            {refInfo.at.length > 0 ? (
              <p className="text-sm text-muted-foreground">
                Fills{' '}
                {refInfo.at.map((at, index) => (
                  <span key={at}>
                    {index > 0 ? ', ' : ''}
                    <code className="font-mono text-foreground">{at}</code>
                  </span>
                ))}
                .
              </p>
            ) : null}
          </div>
          {secret || template === undefined ? (
            <p className="text-sm text-muted-foreground">
              The value is secret, so only the variable's name is shown.
            </p>
          ) : (
            <div className="flex flex-col gap-1.5">
              <p className="text-xs font-medium text-subtle-foreground">
                In browserhive.config.json
              </p>
              <Template text={template} />
            </div>
          )}
        </div>
        <a
          href={docsUrl('configurationReferences')}
          target="_blank"
          rel="noreferrer"
          className="group/docs flex items-center justify-between gap-2 rounded-b-xl border-t px-4 py-2.5 text-sm font-medium text-accent-text transition-colors hover:bg-accent/60 focus-ring-inset focus-visible:bg-accent/60"
        >
          How references work
          <External
            aria-hidden="true"
            className="size-3.5 transition-transform duration-(--duration-fast) group-hover/docs:translate-x-0.5 group-hover/docs:-translate-y-0.5"
          />
        </a>
      </PopoverContent>
    </Popover>
  );
}
