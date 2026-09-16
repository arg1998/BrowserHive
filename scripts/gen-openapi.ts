/** @module scripts/gen-openapi — writes `packages/contracts/generated/openapi.json` from the route descriptors; `--check` fails on drift. */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { openApiDocumentJson } from '../packages/core/src/interface/http/openapi-json.ts';

const OUT = join(import.meta.dir, '..', 'packages', 'contracts', 'generated', 'openapi.json');
const check = process.argv.includes('--check');
const generated = openApiDocumentJson();

if (check) {
  let current = '';
  try {
    current = readFileSync(OUT, 'utf8');
  } catch {
    current = '';
  }
  if (current !== generated) {
    console.error('openapi.json is out of date; run `bun scripts/gen-openapi.ts`');
    process.exit(1);
  }
  console.log('openapi.json is up to date');
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, generated);
  console.log(`wrote ${OUT}`);
}
