/** @module ports/credentials-file — the one-time seed password file `<data-dir>/admin/credentials.txt` (D-24, spec 03 §3.4). */

import type { Secret } from '../kernel/secret.ts';

/** Writes and shreds the seed credentials file. */
export interface CredentialsFile {
  /** Absolute path of the file. */
  readonly path: string;
  /** Writes `password` (plus a newline) with mode 0600 inside a 0700 directory. */
  write(password: Secret<string>): Promise<void>;
  /** Overwrites the file with zeros and unlinks it. A missing file is not an error. */
  shred(): Promise<void>;
  /** True when the file currently exists. */
  exists(): Promise<boolean>;
}
