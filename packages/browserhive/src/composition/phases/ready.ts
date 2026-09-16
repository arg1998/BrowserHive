/** @module composition/phases/ready — phase 7: `/health` flips to ready, `system.status` lifecycle `ready`, the banner is printed once through `output`. */

import { configSourceSummary, hostRamGib } from '@browserhive/core/config';
import { listBackups } from '@browserhive/core/persistence';
import { resolveColor } from '@browserhive/core/runtime';
import { pinnedPlaywrightVersion } from '@browserhive/core/server';
import { type BannerFacts, renderBanner } from '../banner.ts';
import { type BootContext, part } from '../context.ts';
import type { PhaseHandle } from '../unwind.ts';
import { patchrightVersion } from './wire-observers.ts';

/** Gathers the banner facts from the finished context. */
export async function bannerFacts(ctx: BootContext): Promise<BannerFacts> {
  const { config, input } = ctx;
  const storage = part(ctx.storage, 'storage');
  const domain = part(ctx.domain, 'domain');
  const driverName = domain.driverName();
  const sizeBytes = await storage.analytics.databaseSize().catch(() => 0);
  const overview = await domain.vault.overview().catch(() => null);
  const provenance = input.resolved.provenance;
  return {
    version: input.appVersion,
    bunVersion: Bun.version,
    driver: {
      name: driverName,
      version: driverName === 'patchright' ? patchrightVersion() : pinnedPlaywrightVersion(),
    },
    transport: ctx.transport,
    url: ctx.listeners?.url ?? null,
    auth: config.auth,
    admin: config.admin,
    dataDir: config.dataDir,
    db: {
      schemaVersion: storage.handle.schemaVersion,
      sizeBytes,
      backups: listBackups(storage.handle.backupsDir).length,
    },
    configSummary: configSourceSummary(provenance, input.resolved.configFilePath),
    sessions: {
      cap: config.maxSessions,
      derivedFromGib:
        provenance.maxSessions.source === 'derived'
          ? hostRamGib(input.host.totalMemoryBytes)
          : null,
      lease: provenance.sessionLease.rendered,
      persistence: config.persistence,
    },
    stealth: { level: config.stealth, humanize: config.humanize, fingerprint: config.fingerprint },
    telemetry: config.otel
      ? { endpoint: config.otelEndpoint, protocol: config.otelProtocol }
      : null,
    vault: { backend: domain.vaultBackend, unlocked: overview?.unlocked ?? false },
    shadowLines: input.resolved.diagnostics.shadowLines.map((line) => line.text),
    warnings: input.resolved.diagnostics.warnings,
    adminPassword: domain.seeds.adminPassword,
    agentToken: domain.seeds.agentToken,
    browserMissing: !domain.browserInstalled,
  };
}

/** Phase `ready`. */
export async function readyPhase(ctx: BootContext): Promise<PhaseHandle> {
  const observers = part(ctx.observers, 'observers');
  ctx.health.markReady(() => (observers.status.status() === 'degraded' ? 'degraded' : 'ready'));
  observers.status.setLifecycle('ready');
  const facts = await bannerFacts(ctx);
  const output = ctx.input.output;
  // Human output: stdout on http, stderr under stdio (stdout is the MCP stream).
  const stdio = ctx.transport === 'stdio';
  const write = stdio ? output.stderr : output.stdout;
  const color = resolveColor(
    ctx.config.color,
    ctx.input.env,
    stdio ? output.isTty.stderr : output.isTty.stdout,
  );
  for (const line of renderBanner(facts, { color })) write(line);
  return {
    async stop() {
      observers.status.setLifecycle('stopping');
    },
  };
}
