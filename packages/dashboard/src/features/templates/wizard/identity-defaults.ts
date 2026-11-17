/** @module features/templates/wizard/identity-defaults — what step 3 offers and what the server would pick without a choice: browser channels with their names, stealth levels, and the defaults from `GET /system` plus the machine's time zone */
import type { Channel, HeadedWindows, StealthLevel } from '@browserhive/contracts/enums';
import type { SystemInfo } from '@browserhive/contracts/http';

/** Channel names. */
export const CHANNEL_LABEL: { readonly [C in Channel]: string } = {
  chromium: 'Chromium',
  chrome: 'Google Chrome',
  edge: 'Microsoft Edge',
};

/** Agent windows choices, minimized first (the default unless the operator changed it, D-77). */
export const AGENT_WINDOWS: readonly { readonly value: HeadedWindows; readonly label: string }[] = [
  { value: 'minimized', label: 'Minimized' },
  { value: 'normal', label: 'Normal' },
];

/** The Agent windows options, the server's default marked. */
export function agentWindowsOptions(
  serverDefault: HeadedWindows,
): { readonly value: HeadedWindows; readonly label: string }[] {
  return AGENT_WINDOWS.map((o) => ({
    value: o.value,
    label: `${o.label}${o.value === serverDefault ? ' (default)' : ''}`,
  }));
}

/** Stealth levels in order. */
export const STEALTH: readonly { readonly value: StealthLevel; readonly label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'standard', label: 'Standard' },
  { value: 'max', label: 'Max' },
];

/** What the server would pick, for "default" labels. */
export interface IdentityDefaults {
  readonly channel: Channel;
  readonly stealth: StealthLevel;
  readonly fingerprint: boolean;
  /** Agent windows of a new template: the server's `headedWindows` setting. */
  readonly agentWindows: HeadedWindows;
  /** Installed channels; `null` while unknown (nothing is marked missing then). */
  readonly installed: ReadonlySet<Channel> | null;
  /** The time zone of the BrowserHive machine. */
  readonly timeZone: string | null;
  /** The language of this browser (the closest the dashboard knows). */
  readonly locale: string;
}

/** Server defaults from `GET /system`. */
export function identityDefaults(
  system: SystemInfo | undefined,
  timeZone: string | null,
  locale: string,
): IdentityDefaults {
  const profile = system?.stealth.profile;
  return {
    channel: system?.browser?.default_channel ?? 'chromium',
    stealth: profile === 'off' || profile === 'max' ? profile : 'standard',
    fingerprint: system?.stealth.fingerprint ?? true,
    agentWindows: system?.browser?.headed_windows ?? 'minimized',
    installed:
      system?.browser === undefined
        ? null
        : new Set(system.browser.channels.filter((c) => c.installed).map((c) => c.channel)),
    timeZone,
    locale,
  };
}
