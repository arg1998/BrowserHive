/** @module domain/site-packs/guard-enums.test — the pack schema's method and resource-type enums equal the request guard's (build-T0b handoff, deferred D12). */

import { describe, expect, it } from 'bun:test';
import { PACK_GUARD_METHODS, PACK_RESOURCE_TYPES } from '@browserhive/contracts/site-packs';
import { GUARD_METHODS, GUARD_RESOURCE_TYPES } from '../policies/request-guard.ts';

describe('guard enums', () => {
  it('contracts and the request guard name the same methods and resource types', () => {
    expect([...PACK_GUARD_METHODS]).toEqual([...GUARD_METHODS]);
    expect([...PACK_RESOURCE_TYPES]).toEqual([...GUARD_RESOURCE_TYPES]);
  });
});
