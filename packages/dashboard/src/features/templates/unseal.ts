/** @module features/templates/unseal — the four unseal flags of a template (spec 13 §5.4, D-51) with each one's switch label and the editor text the wizard and the Access tab show */

/** The unseal flags in editor order. */
export const UNSEAL_FLAGS = ['cookie_values', 'evaluate', 'cookie_writes', 'state_export'] as const;
/** An unseal flag. */
export type UnsealFlag = (typeof UNSEAL_FLAGS)[number];

/** Each flag's switch label (the plain words first, the tool term second) and the editor text of spec 13 §5.4. */
export const UNSEAL_TEXT: {
  readonly [K in UnsealFlag]: {
    readonly label: string;
    readonly short: string;
    readonly text: string;
  };
} = {
  cookie_values: {
    label: 'Allow reading cookie values',
    short: 'reading cookie values',
    text: 'Agents can copy these sign-ins out of BrowserHive.',
  },
  evaluate: {
    label: 'Allow running page scripts (evaluate)',
    short: 'running page scripts',
    text: 'The agent can read the site’s stored data and the cookies pages can see, and can leave code that other sessions of this template will load. Treat it as turning off sign-in protection for every agent this applies to.',
  },
  cookie_writes: {
    label: 'Allow changing cookies',
    short: 'changing cookies',
    text: 'Changes the sign-ins of every session of this template.',
  },
  state_export: {
    label: 'Allow saving a copy of the sign-in (storage state)',
    short: 'saving a copy of the sign-in',
    text: 'Like showing cookie values: sessions started from a saved copy are copies of this sign-in and can sign the template out.',
  },
};
