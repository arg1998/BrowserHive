/** @module features/site-packs/PackControls — a pack's settings as controls (spec 13 §10.6, §11.4): **Follow updates** (Auto, On, Off), **Enabled** (turning it off asks first), **Turn off…** as a button (a revoked version kept in force), **Revert…** behind a confirmation classified like Apply (the diff from the version in force to the previous one, review #84 L4) when a previous version exists, a below-floor refusal of Revert explained in a dialog (D-71), and the row menu that reaches all of them from the keyboard (Shift+F10 on a table row) */
import type { SitePackView } from '@browserhive/contracts/http';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useApi } from '@/app/providers/AuthProvider.tsx';
import { useConfirm } from '@/app/providers/ConfirmProvider.tsx';
import { useToast } from '@/app/providers/ToastProvider.tsx';
import { useRowControlTabIndex } from '@/components/shared/row-context.ts';
import { Button } from '@/components/ui/button.tsx';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx';
import { Switch } from '@/components/ui/switch.tsx';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group.tsx';
import { toAppError } from '@/lib/api/errors.ts';
import { ICONS } from '@/lib/icons.ts';
import { useSitePackActions } from './api.ts';
import { disableConfirm, revertConfirm } from './confirm-copy.ts';
import { type FloorDetails, FloorDialog, floorRefusalOf } from './FloorRefusal.tsx';
import { FOLLOW_LABEL, iso } from './model.ts';

type Follow = SitePackView['follow']['setting'];
const FOLLOWS: readonly Follow[] = ['auto', 'on', 'off'];

function followBody(setting: Follow): boolean | null {
  return setting === 'auto' ? null : setting === 'on';
}

/** The pack's actions with the toasts they end in. */
function usePackSettings(pack: SitePackView) {
  const actions = useSitePackActions(pack.pack_id);
  const api = useApi();
  const toast = useToast();
  const confirm = useConfirm();
  const [revertRefusal, setRevertRefusal] = useState<FloorDetails | null>(null);
  const [revertRefusalOpen, setRevertRefusalOpen] = useState(false);
  // What going back changes, classified like Apply; unknown when the diff cannot be read.
  const revertDiff = async () => {
    if (pack.previous === null) return undefined;
    try {
      return await api.diffSitePack({
        params: { pack_id: pack.pack_id },
        query: { to: pack.previous.version },
      });
    } catch {
      return undefined;
    }
  };
  return {
    busy: actions.follow.isPending || actions.setEnabled.isPending || actions.revert.isPending,
    follow: (setting: Follow) =>
      actions.follow.mutate(followBody(setting), {
        onSuccess: () =>
          toast.success({
            title: `${iso(pack.title)}: follow updates ${FOLLOW_LABEL[setting].toLowerCase()}`,
          }),
      }),
    setEnabled: async (enabled: boolean) => {
      // Turning a pack off drops its guards for every template using it: ask first (review S-M2).
      if (!enabled && !(await confirm(disableConfirm(pack)))) return;
      actions.setEnabled.mutate(enabled, {
        onSuccess: () =>
          toast.success({ title: `${iso(pack.title)} ${enabled ? 'enabled' : 'turned off'}` }),
      });
    },
    revert: async () => {
      if (!(await confirm(revertConfirm(pack, await revertDiff())))) return;
      actions.revert.mutate(undefined, {
        onSuccess: () => toast.success({ title: `${iso(pack.title)} reverted` }),
        // A below-floor refusal is explained in a dialog, not a toast (D-71).
        onError: (error: unknown) => {
          const refusal = floorRefusalOf(toAppError(error));
          if (refusal === null) return;
          setRevertRefusal(refusal);
          setRevertRefusalOpen(true);
        },
      });
    },
    revertRefusal,
    revertRefusalOpen,
    setRevertRefusalOpen,
  };
}

/** Revert refused below a template's stealth floor: the dialog, until closed. */
function RevertRefusal({
  pack,
  settings,
}: {
  readonly pack: SitePackView;
  readonly settings: ReturnType<typeof usePackSettings>;
}) {
  if (settings.revertRefusal === null) return null;
  return (
    <FloorDialog
      refusal={settings.revertRefusal}
      title={pack.title}
      action="revert"
      open={settings.revertRefusalOpen}
      onOpenChange={settings.setRevertRefusalOpen}
    />
  );
}

/** Follow updates: Auto, On, Off; Auto says what it means right now. */
export function FollowToggle({
  pack,
  label,
}: {
  readonly pack: SitePackView;
  readonly label?: string;
}) {
  const settings = usePackSettings(pack);
  const tabIndex = useRowControlTabIndex();
  return (
    <ToggleGroup
      aria-label={label ?? `Follow updates of ${pack.title}`}
      size="sm"
      spacing={0}
      disabled={settings.busy}
      value={[pack.follow.setting]}
      onValueChange={(next: readonly unknown[]) => {
        const value = next[0];
        if (value === 'auto' || value === 'on' || value === 'off') settings.follow(value);
      }}
    >
      {FOLLOWS.map((setting) => (
        <ToggleGroupItem
          key={setting}
          value={setting}
          {...(tabIndex !== undefined && { tabIndex })}
        >
          {FOLLOW_LABEL[setting]}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

/** Enabled switch. */
export function EnabledSwitch({ pack, id }: { readonly pack: SitePackView; readonly id?: string }) {
  const settings = usePackSettings(pack);
  const tabIndex = useRowControlTabIndex();
  return (
    <Switch
      {...(id !== undefined ? { id } : { 'aria-label': `${pack.title} enabled` })}
      {...(tabIndex !== undefined && { tabIndex })}
      checked={pack.enabled}
      disabled={settings.busy}
      onCheckedChange={(enabled: boolean) => void settings.setEnabled(enabled)}
    />
  );
}

/** Revert to the previous approved version (only when one exists). */
export function RevertButton({ pack }: { readonly pack: SitePackView }) {
  const settings = usePackSettings(pack);
  if (pack.previous === null) return null;
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={settings.busy}
        onClick={() => void settings.revert()}
      >
        <ICONS.restore aria-hidden="true" />
        Revert to v{pack.previous.version}…
      </Button>
      <RevertRefusal pack={pack} settings={settings} />
    </>
  );
}

/** Turn the pack off (asks first); nothing once it is off. */
export function TurnOffButton({ pack }: { readonly pack: SitePackView }) {
  const settings = usePackSettings(pack);
  if (!pack.enabled) return null;
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={settings.busy}
      onClick={() => void settings.setEnabled(false)}
    >
      Turn off…
    </Button>
  );
}

/** The row menu: Open, Follow updates, Enabled, Revert…. */
export function PackMenu({ pack }: { readonly pack: SitePackView }) {
  const settings = usePackSettings(pack);
  const navigate = useNavigate();
  const tabIndex = useRowControlTabIndex();
  return (
    <>
      <RevertRefusal pack={pack} settings={settings} />
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Actions for ${pack.title}`}
              tabIndex={tabIndex}
              disabled={settings.busy}
            />
          }
        >
          <ICONS.more aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-52">
          <DropdownMenuItem
            onClick={() => void navigate({ to: '/site-packs/$id', params: { id: pack.pack_id } })}
          >
            <ICONS.arrowUpRight aria-hidden="true" />
            Open
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Follow updates</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={pack.follow.setting}
            onValueChange={(value: unknown) => {
              if (value === 'auto' || value === 'on' || value === 'off') settings.follow(value);
            }}
          >
            {FOLLOWS.map((setting) => (
              <DropdownMenuRadioItem key={setting} value={setting}>
                {FOLLOW_LABEL[setting]}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuCheckboxItem
            checked={pack.enabled}
            onCheckedChange={(checked: boolean) => void settings.setEnabled(checked)}
          >
            Enabled
          </DropdownMenuCheckboxItem>
          {pack.previous !== null ? (
            <DropdownMenuItem variant="destructive" onClick={() => void settings.revert()}>
              <ICONS.restore aria-hidden="true" />
              Revert to v{pack.previous.version}…
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
