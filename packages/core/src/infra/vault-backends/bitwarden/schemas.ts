/** @module infra/vault-backends/bitwarden/schemas — zod schemas for the `bw` CLI's JSON output (untrusted; every field optional). */

import { z } from 'zod';

/** `bw status` — only the lock state is read. */
export const BwStatus = z.object({
  status: z.enum(['unlocked', 'locked', 'unauthenticated']),
});
/** Parsed `bw status`. */
export type BwStatus = z.infer<typeof BwStatus>;

/** The `login` object of an item; secrets stay in this parsed value only until wrapped. */
export const BwLogin = z.object({
  username: z.string().nullish(),
  password: z.string().nullish(),
  totp: z.string().nullish(),
  uris: z.array(z.object({ uri: z.unknown() }).nullable()).nullish(),
});
/** Parsed `login` object. */
export type BwLogin = z.infer<typeof BwLogin>;

/** One `bw list items` / `bw get item` object. */
export const BwItem = z.object({
  id: z.string().nullish(),
  name: z.string().nullish(),
  folderId: z.string().nullish(),
  login: BwLogin.nullish(),
});
/** Parsed item. */
export type BwItem = z.infer<typeof BwItem>;

/** `bw list items` output. */
export const BwItemList = z.array(BwItem);

/** One `bw list folders` object. */
export const BwFolder = z.object({ id: z.string().nullish(), name: z.string().nullish() });
/** `bw list folders` output. */
export const BwFolderList = z.array(BwFolder);

/** Normalises a raw `folderId`: non-empty string → GUID, anything else → ungrouped (`null`). */
export function normGroupId(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The saved login URIs of an item (may be empty). */
export function loginUris(login: BwLogin | null | undefined): readonly string[] {
  const out: string[] = [];
  for (const u of login?.uris ?? []) {
    if (u !== null && typeof u.uri === 'string') out.push(u.uri);
  }
  return out;
}
