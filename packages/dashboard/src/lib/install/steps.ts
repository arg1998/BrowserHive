/** @module lib/install/steps — each browser's own install steps (04 §18.8.3), with where they come from and the version they were checked against. Pure data; no imports. The manual gate (04 §18.12) re-checks Chrome and Edge. */

/** A run of text, or the name of a menu item or button (rendered emphasised). */
export type StepSegment = string | { readonly ui: string };

/** Which browser the steps are for. */
export type StepsBrand = 'chrome' | 'edge' | 'chromium-other' | 'firefox-windows';

/** One entry of 04 §18.8.3. */
export interface InstallSteps {
  readonly brand: StepsBrand;
  /** The browser's name, as the dialog shows it (`null`: the generic Chromium entry). */
  readonly browser: string | null;
  readonly steps: readonly StepSegment[];
  /** Where the steps come from. */
  readonly source: { readonly title: string; readonly url: string | null };
  /** The browser version and month they were checked against. */
  readonly checkedAgainst: string;
}

/** 04 §18.8.3. */
export const INSTALL_STEPS: { readonly [B in StepsBrand]: InstallSteps } = {
  chrome: {
    brand: 'chrome',
    browser: 'Google Chrome',
    steps: [
      'Click the install icon at the right of the address bar, or open the ',
      { ui: '⋮' },
      ' menu › ',
      { ui: 'Cast, save, and share' },
      ' › ',
      { ui: 'Install page as app…' },
      '.',
    ],
    source: {
      title: 'Google Chrome Help, "Use progressive web apps"',
      url: 'https://support.google.com/chrome/answer/9658361',
    },
    checkedAgainst: 'Chrome 154 (desktop), 2026-11',
  },
  edge: {
    brand: 'edge',
    browser: 'Microsoft Edge',
    steps: [
      'Click ',
      { ui: 'App available' },
      ' in the address bar, or open the ',
      { ui: '…' },
      ' menu › ',
      { ui: 'More tools' },
      ' › ',
      { ui: 'Apps' },
      ' › ',
      { ui: 'Install this site as an app' },
      '.',
    ],
    source: {
      title: 'Microsoft Support, "Install, manage, or uninstall apps in Microsoft Edge"',
      url: null,
    },
    checkedAgainst: 'Edge 154 (desktop), 2026-11',
  },
  'chromium-other': {
    brand: 'chromium-other',
    browser: null,
    steps: [
      'Click the install icon in the address bar, or look for ',
      { ui: 'Install' },
      ' in the browser menu.',
    ],
    source: { title: 'generic (Brave, Opera, Vivaldi and other Chromium browsers)', url: null },
    checkedAgainst: 'Chromium 153, 2026-11',
  },
  'firefox-windows': {
    brand: 'firefox-windows',
    browser: 'Firefox',
    steps: ['Click the web-apps icon in the address bar, then ', { ui: 'Add to taskbar' }, '.'],
    source: { title: 'Mozilla Support; firefox-source-docs "taskbartabs"', url: null },
    checkedAgainst: 'Firefox 143+ on Windows, 2026-11',
  },
};
