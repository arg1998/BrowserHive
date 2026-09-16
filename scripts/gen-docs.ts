/** @module scripts/gen-docs — generates docs/reference/* from @browserhive/contracts; `--check` fails on drift */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { configFileJsonSchema } from '@browserhive/contracts/config';
import { type OperationSummaries, renderApi, summariesFromOpenApi } from './gen-docs/api.ts';
import { renderConfiguration } from './gen-docs/configuration.ts';
import { renderErrors } from './gen-docs/errors.ts';
import { renderTools } from './gen-docs/tools.ts';
import { renderWebsocket } from './gen-docs/websocket.ts';

const ROOT = resolve(import.meta.dir, '..');
const OPENAPI_PATH = join(ROOT, 'packages/contracts/generated/openapi.json');

function loadSummaries(): OperationSummaries {
  if (!existsSync(OPENAPI_PATH)) return new Map();
  const parsed: unknown = JSON.parse(readFileSync(OPENAPI_PATH, 'utf8'));
  return summariesFromOpenApi(parsed);
}

/**
 * Render every generated reference file in memory.
 *
 * @returns Absolute path → file content, in a fixed order.
 */
export function renderAll(): ReadonlyMap<string, string> {
  const ref = (name: string): string => join(ROOT, 'docs/reference', name);
  return new Map([
    [ref('configuration.md'), renderConfiguration()],
    [ref('errors.md'), renderErrors()],
    [ref('tools.md'), renderTools()],
    [ref('api.md'), renderApi(loadSummaries())],
    [ref('websocket.md'), renderWebsocket()],
    [ref('config.schema.json'), `${JSON.stringify(configFileJsonSchema(), null, 2)}\n`],
  ]);
}

function firstDifference(expected: string, actual: string): string {
  const want = expected.split('\n');
  const have = actual.split('\n');
  const max = Math.max(want.length, have.length);
  for (let i = 0; i < max; i += 1) {
    if (want[i] !== have[i]) {
      return `line ${i + 1}:\n    expected: ${want[i] ?? '<end of file>'}\n    actual:   ${have[i] ?? '<end of file>'}`;
    }
  }
  return 'content differs';
}

function check(files: ReadonlyMap<string, string>): number {
  const stale: string[] = [];
  for (const [path, content] of files) {
    const rel = relative(ROOT, path);
    if (!existsSync(path)) {
      stale.push(`  ${rel}: missing`);
      continue;
    }
    const current = readFileSync(path, 'utf8');
    if (current !== content) stale.push(`  ${rel}: ${firstDifference(content, current)}`);
  }
  if (stale.length === 0) {
    console.log(`gen-docs: ${files.size} generated files are up to date`);
    return 0;
  }
  console.error(`gen-docs: ${stale.length} generated file(s) are stale:`);
  for (const line of stale) console.error(line);
  console.error('Run `bun run gen:docs` and commit the result.');
  return 1;
}

function write(files: ReadonlyMap<string, string>): number {
  for (const [path, content] of files) {
    mkdirSync(dirname(path), { recursive: true });
    const unchanged = existsSync(path) && readFileSync(path, 'utf8') === content;
    if (!unchanged) writeFileSync(path, content);
    console.log(`gen-docs: ${unchanged ? 'unchanged' : 'wrote'} ${relative(ROOT, path)}`);
  }
  return 0;
}

if (import.meta.main) {
  const files = renderAll();
  process.exit(process.argv.includes('--check') ? check(files) : write(files));
}
