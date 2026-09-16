/** @module infra/ids/nanoid-id-generator — the one nanoid/ULID call site implementing the IdGenerator port (D-23). */

import { customAlphabet, nanoid } from 'nanoid';
import { ID_ALPHABET, ID_SUFFIX_LENGTH } from '../../kernel/slug.ts';
import type { Clock } from '../../ports/clock.ts';
import type { IdGenerator } from '../../ports/id-generator.ts';
import { createUlidFactory } from './ulid.ts';

/** Length of the tab-id suffix (`t-<nanoid6>`). */
export const TAB_ID_LENGTH = 6;

/** Length of the operator-request suffix (`a-<nanoid12>`). */
export const OPERATOR_REQUEST_ID_LENGTH = 12;

/** Options for {@link createNanoidIdGenerator}. */
export interface NanoidIdGeneratorOptions {
  /** Time source for ULID event ids. */
  readonly clock: Clock;
}

/**
 * Builds the production {@link IdGenerator}. Session and tab suffixes use the lowercase
 * `0-9a-z` alphabet so the ids are single filesystem-safe tokens; event ids are monotonic ULIDs;
 * opaque ids use nanoid's URL-safe alphabet.
 */
export function createNanoidIdGenerator(options: NanoidIdGeneratorOptions): IdGenerator {
  const sessionSuffix = customAlphabet(ID_ALPHABET, ID_SUFFIX_LENGTH);
  const tabSuffix = customAlphabet(ID_ALPHABET, TAB_ID_LENGTH);
  const ulid = createUlidFactory({ now: () => options.clock.now() });
  return {
    sessionId(slug) {
      return `${slug}-${sessionSuffix()}`;
    },
    tabId() {
      return `t-${tabSuffix()}`;
    },
    eventId() {
      return `e-${ulid()}`;
    },
    operatorRequestId() {
      return `a-${nanoid(OPERATOR_REQUEST_ID_LENGTH)}`;
    },
    opaque(size) {
      return nanoid(Math.max(1, Math.floor(size)));
    },
  };
}
