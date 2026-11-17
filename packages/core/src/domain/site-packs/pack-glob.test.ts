/** @module domain/site-packs/pack-glob.test — pack globs matched with the guard grammar, and `packGlobsOverlap`: whether a guard's glob can match a sign-in post target (review #84 N4). */

import { describe, expect, it } from 'bun:test';
import { matchesPackGlob, packGlobsOverlap } from './pack-glob.ts';

describe('packGlobsOverlap', () => {
  const SUBMIT = 'www.linkedin.com/checkpoint/lg/login-submit';

  it('overlaps a target, a wider glob, its sub-paths and its query variant', () => {
    expect(packGlobsOverlap(SUBMIT, SUBMIT)).toBe(true);
    expect(packGlobsOverlap('www.linkedin.com/checkpoint/*', SUBMIT)).toBe(true);
    expect(packGlobsOverlap('*.linkedin.com/checkpoint/lg*', SUBMIT)).toBe(true);
    expect(packGlobsOverlap(`${SUBMIT}/now`, SUBMIT)).toBe(true);
    expect(packGlobsOverlap(`${SUBMIT}?flow=*`, SUBMIT)).toBe(true);
    // Case and unreserved escapes are read as the request guard reads them.
    expect(packGlobsOverlap('WWW.LinkedIn.com/checkpoint/lg/login%2Dsubmit', SUBMIT)).toBe(true);
    // Both directions.
    expect(packGlobsOverlap(SUBMIT, 'www.linkedin.com/checkpoint/*')).toBe(true);
  });

  it('does not overlap another path, another host or a longer sibling', () => {
    expect(packGlobsOverlap('www.linkedin.com/settings', SUBMIT)).toBe(false);
    expect(packGlobsOverlap('www.linkedin.com/uas/logout', SUBMIT)).toBe(false);
    expect(packGlobsOverlap('linkedin.com/checkpoint/*', SUBMIT)).toBe(false);
    expect(packGlobsOverlap(`${SUBMIT}-help`, SUBMIT)).toBe(false);
    expect(packGlobsOverlap('github.com/session', 'github.com/sessions/*')).toBe(false);
    // A host wildcard does not reach into the path or the query.
    expect(packGlobsOverlap('*.linkedin.com/jobs/apply*', SUBMIT)).toBe(false);
  });

  it('agrees with matchesPackGlob on a witness URL', () => {
    const url = 'https://www.linkedin.com/checkpoint/lg/login-submit?loginCsrfParam=x';
    expect(matchesPackGlob(SUBMIT, url)).toBe(true);
    expect(matchesPackGlob('www.linkedin.com/checkpoint/*', url)).toBe(true);
    expect(packGlobsOverlap(SUBMIT, 'www.linkedin.com/checkpoint/*')).toBe(true);
  });
});
