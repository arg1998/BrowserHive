/**
 * Copies the signed site-pack registry into the built site, `dist/registry/v1/` (spec 13 §10.8):
 * `bun scripts/copy-registry.ts <signed layout dir>` after `astro build`, or `bun run build` with
 * `REGISTRY_DIR` set. Without either, nothing is copied (a local build has no signed registry).
 */
import { join } from 'node:path';
import { copyRegistry } from './registry-layout.ts';

const from = process.argv[2] ?? process.env['REGISTRY_DIR'];
if (from === undefined || from === '') {
  console.log('copy-registry: no signed registry given (argument or REGISTRY_DIR); skipped');
} else {
  const copied = copyRegistry(from, join(import.meta.dir, '..', 'dist'));
  console.log(
    copied === 0
      ? `copy-registry: ${from} holds no registry; the site has none`
      : `copy-registry: ${copied} file(s) -> dist/registry/v1/`,
  );
}
