/** @module features/templates/unseal — the four unseal flags of a template (spec 13 §5.4, D-51) with each one's switch label and the editor text the wizard and the Access tab show */

/** The unseal flags in editor order. */
export const UNSEAL_FLAGS = ['cookie_values', 'evaluate', 'cookie_writes', 'state_export'] as const;
/** An unseal flag. */
export type UnsealFlag = (typeof UNSEAL_FLAGS)[number];

/** Each flag's switch label and the editor text of spec 13 §5.4. */
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
    label: 'Allow evaluate',
    short: 'evaluate',
    text: 'The agent can read storage and non-HttpOnly cookies and can run code that other sessions of this template will load (storage, caches, service workers). Treat it as unsealing everything for every agent this applies to.',
  },
  cookie_writes: {
    label: 'Allow setting cookies',
    short: 'setting cookies',
    text: 'Changes the sign-ins of every session of this template.',
  },
  state_export: {
    label: 'Allow saving the storage state',
    short: 'saving the storage state',
    text: 'Equivalent to showing cookie values. Sessions started from an exported state are copies of this sign-in and can sign the template out.',
  },
};
