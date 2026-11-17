/** @module composition/self-origins — BrowserHive's own origins (spec 13 §3.8) for the template hosts' self-origin guard and the tools' `#browserhive` refusal; split from `phases/domain-templates.ts` (review #83 L7). */

import { hostname, networkInterfaces } from 'node:os';
import type { ServerConfig } from '@browserhive/contracts/config';

/** The machine's names and addresses, for a wildcard bind (test seam). */
export interface MachineNames {
  readonly hostname: string;
  readonly addresses: readonly string[];
}

/** This machine's host name and interface addresses. */
export function machineNames(): MachineNames {
  const addresses = Object.values(networkInterfaces())
    .flat()
    .flatMap((info) => (info === undefined ? [] : [info.address]));
  return { hostname: hostname(), addresses };
}

/**
 * BrowserHive's own origins (spec 13 §3.8): the self-origin guard of a template host blocks them,
 * and every loopback spelling on their ports; the host's marker cookie is set for each. The bound
 * host, the canonical loopback names, the extra `allowedHosts` and the `publicUrl` origin; under a
 * wildcard bind also the machine's host name (and `<name>.local`) and every interface address.
 */
export function selfOriginsOf(
  config: Readonly<ServerConfig>,
  machineOf: () => MachineNames = machineNames,
): string[] {
  const port = config.port;
  const hosts = new Set([config.host, 'localhost', '127.0.0.1', '::1', ...config.allowedHosts]);
  if (['0.0.0.0', '::', ''].includes(config.host)) {
    // Read only for a wildcard bind: the interface list can be slow to read (Windows).
    const machine = machineOf();
    hosts.add(machine.hostname);
    hosts.add(`${machine.hostname}.local`);
    for (const address of machine.addresses) hosts.add(address);
  }
  const origins = [...hosts]
    .filter((host) => host !== '' && host !== '::')
    .flatMap((host) => {
      const bare = host.replace(/^\[|\]$/g, '');
      const name = bare.includes(':') ? `[${bare}]` : bare;
      return port > 0 ? [`http://${name}:${port}`, `https://${name}:${port}`] : [];
    });
  if (config.publicUrl !== undefined) origins.push(config.publicUrl);
  return origins;
}
