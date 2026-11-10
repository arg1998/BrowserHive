/** @module infra/persistence/profile-secrets.test — saved passwords and autofill found and cleared in a Chromium profile (spec 13 §3.1). */

import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearProfileSecrets, profileHasSecrets } from './profile-secrets.ts';

function profile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bh-profile-'));
  mkdirSync(join(dir, 'Default'));
  return dir;
}

function table(path: string, name: string, rows: number): void {
  const db = new Database(path, { create: true });
  db.run(`CREATE TABLE "${name}" (value TEXT)`);
  for (let i = 0; i < rows; i++) db.run(`INSERT INTO "${name}" VALUES ('x')`);
  db.close();
}

describe('profile secrets', () => {
  it('reports nothing for a profile without the files or with empty tables', () => {
    const dir = profile();
    expect(profileHasSecrets(dir)).toBe(false);
    table(join(dir, 'Default', 'Login Data'), 'logins', 0);
    table(join(dir, 'Default', 'Web Data'), 'autofill', 0);
    expect(profileHasSecrets(dir)).toBe(false);
  });

  it('finds saved passwords and autofill entries, and clears both', () => {
    const passwords = profile();
    table(join(passwords, 'Default', 'Login Data'), 'logins', 2);
    expect(profileHasSecrets(passwords)).toBe(true);
    clearProfileSecrets(passwords);
    expect(profileHasSecrets(passwords)).toBe(false);

    const autofill = profile();
    table(join(autofill, 'Default', 'Web Data'), 'credit_cards', 1);
    expect(profileHasSecrets(autofill)).toBe(true);
    clearProfileSecrets(autofill);
    expect(profileHasSecrets(autofill)).toBe(false);
  });

  it('reads a file that is not SQLite as empty', async () => {
    const dir = profile();
    await Bun.write(join(dir, 'Default', 'Login Data'), 'not a database');
    expect(profileHasSecrets(dir)).toBe(false);
  });

  it('a clear that cannot clear fails instead of reporting an empty profile (review L-4)', async () => {
    const dir = profile();
    await Bun.write(join(dir, 'Default', 'Login Data'), 'not a database');
    expect(() => clearProfileSecrets(dir)).toThrow();
  });
});
