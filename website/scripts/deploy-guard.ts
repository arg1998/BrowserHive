/**
 * Refuses a website deploy that would delete the published site-pack registry (review #97 M1): a
 * Workers assets deploy replaces every file, so a `dist/` without `registry/v1/` removes what
 * browserhive.ai serves. Runs before `wrangler deploy` (`bun run deploy`, and the CI deploy job).
 * A build that carries the registry passes; without it, the deploy goes ahead only when nothing is
 * published, or when CI says the published registry could not be verified and must not be carried
 * (`BH_DEPLOY_DROP_REGISTRY=1`, set only by the deploy job after `carry` refused). To deploy by hand,
 * carry the live registry first (docs/contributing/registry.md, "Deploying the website by hand").
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { SIGNED_FILES } from './registry-layout.ts';

/** What the live site serves at `registry/v1/keys.json`. */
export type LiveRegistry = 'published' | 'none' | 'unknown';

/** Whether the deploy may go ahead, and why. */
export function deployDecision(input: {
  readonly hasRegistry: boolean;
  readonly live: LiveRegistry;
  readonly dropAllowed: boolean;
}): { readonly ok: boolean; readonly message: string } {
  if (input.hasRegistry) return { ok: true, message: 'the build carries the signed registry' };
  if (input.live === 'none') return { ok: true, message: 'nothing is published yet' };
  if (input.live === 'published' && input.dropAllowed) {
    return { ok: true, message: 'the published registry could not be verified; it is dropped' };
  }
  return {
    ok: false,
    message:
      input.live === 'published'
        ? 'this deploy would delete the published site-pack registry: build with REGISTRY_DIR set to a carried layout (docs/contributing/registry.md)'
        : 'could not tell whether a registry is published; refusing to deploy without one',
  };
}

async function liveRegistry(url: string): Promise<LiveRegistry> {
  try {
    const response = await fetch(new URL('keys.json', url), {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 200) return 'published';
    if (response.status === 404) return 'none';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

if (import.meta.main) {
  const dir = join(import.meta.dir, '..', 'dist', 'registry', 'v1');
  const hasRegistry = SIGNED_FILES.every((name) => existsSync(join(dir, name)));
  const url = process.env['REGISTRY_URL'] ?? 'https://browserhive.ai/registry/v1/';
  const decision = deployDecision({
    hasRegistry,
    live: hasRegistry ? 'unknown' : await liveRegistry(url),
    dropAllowed: process.env['BH_DEPLOY_DROP_REGISTRY'] === '1',
  });
  console.log(`deploy-guard: ${decision.message}`);
  if (!decision.ok) process.exit(1);
}
