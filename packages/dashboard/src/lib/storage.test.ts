/** @module lib/storage.test — the `localStorage` and `sessionStorage` helpers: round trips, JSON validation, and silence when storage is blocked */
import { afterEach, describe, expect, it } from 'bun:test';
import {
  readSessionStorage,
  readSessionStorageJson,
  readStorage,
  readStorageJson,
  removeSessionStorage,
  removeStorage,
  writeSessionStorage,
  writeSessionStorageJson,
  writeStorage,
  writeStorageJson,
} from './storage.ts';

type Area = 'localStorage' | 'sessionStorage';

/** Makes reading `globalThis[area]` throw, as a browser with blocked site data does; returns the undo. */
function block(area: Area): () => void {
  const original = Object.getOwnPropertyDescriptor(globalThis, area);
  Object.defineProperty(globalThis, area, {
    configurable: true,
    get: () => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    },
  });
  return () => {
    if (original !== undefined) Object.defineProperty(globalThis, area, original);
  };
}

const isNumberList = (raw: unknown): number[] | null =>
  Array.isArray(raw) && raw.every((n) => typeof n === 'number') ? raw : null;

afterEach(() => {
  globalThis.localStorage.clear();
  globalThis.sessionStorage.clear();
});

describe('localStorage helpers (unchanged)', () => {
  it('round-trips strings and validated JSON', () => {
    writeStorage('k', 'v');
    expect(readStorage('k')).toBe('v');
    writeStorageJson('j', [1, 2]);
    expect(readStorageJson('j', isNumberList)).toEqual([1, 2]);
    removeStorage('k');
    expect(readStorage('k')).toBeNull();
    expect(globalThis.sessionStorage.getItem('k')).toBeNull();
  });
});

describe('sessionStorage helpers', () => {
  it('round-trip strings in sessionStorage only', () => {
    expect(writeSessionStorage('bh.test', 'one')).toBe(true);
    expect(readSessionStorage('bh.test')).toBe('one');
    expect(globalThis.sessionStorage.getItem('bh.test')).toBe('one');
    expect(globalThis.localStorage.getItem('bh.test')).toBeNull();
    removeSessionStorage('bh.test');
    expect(readSessionStorage('bh.test')).toBeNull();
  });

  it('JSON goes through the validator; unparsable or invalid is null', () => {
    expect(writeSessionStorageJson('bh.list', [1, 2, 3])).toBe(true);
    expect(readSessionStorageJson('bh.list', isNumberList)).toEqual([1, 2, 3]);
    globalThis.sessionStorage.setItem('bh.list', '{not json');
    expect(readSessionStorageJson('bh.list', isNumberList)).toBeNull();
    globalThis.sessionStorage.setItem('bh.list', '["a"]');
    expect(readSessionStorageJson('bh.list', isNumberList)).toBeNull();
    expect(readSessionStorageJson('bh.absent', isNumberList)).toBeNull();
  });

  it('never throw when storage is blocked; a failed write reports false', () => {
    const undo = block('sessionStorage');
    try {
      expect(readSessionStorage('bh.test')).toBeNull();
      expect(writeSessionStorage('bh.test', 'x')).toBe(false);
      expect(writeSessionStorageJson('bh.test', [1])).toBe(false);
      expect(readSessionStorageJson('bh.test', isNumberList)).toBeNull();
      expect(() => removeSessionStorage('bh.test')).not.toThrow();
    } finally {
      undo();
    }
    expect(writeSessionStorage('bh.test', 'x')).toBe(true);
  });

  it('a quota failure reports false', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
    const full = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException('Quota exceeded', 'QuotaExceededError');
      },
      removeItem: () => undefined,
    };
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: full });
    try {
      expect(writeSessionStorage('bh.test', 'x')).toBe(false);
    } finally {
      if (original !== undefined) Object.defineProperty(globalThis, 'sessionStorage', original);
    }
  });

  it('blocking localStorage leaves sessionStorage working', () => {
    const undo = block('localStorage');
    try {
      expect(readStorage('k')).toBeNull();
      expect(() => writeStorage('k', 'v')).not.toThrow();
      expect(writeSessionStorage('k', 'v')).toBe(true);
    } finally {
      undo();
    }
  });
});
