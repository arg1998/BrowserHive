/**
 * @module browserhive/test/e2e/template-server — the daemon of the templates end-to-end journey (spec 13 §17
 * T1a): a BrowserHive server from source with the internal testing seam pointing Chromium at the
 * HTTPS fixture sites (`*.test`), and those sites. Run it on a display (CI: `xvfb-run -a`) so the
 * template's sign-in window is a real window.
 *
 * Usage: `bun packages/browserhive/test/e2e/template-server.ts <port> <dataDir>`; stops on SIGINT/SIGTERM.
 */

import { FIXTURE_SPKI, startHttpsSites } from '@browserhive/core/test/https-sites';
import { createServer } from '../../src/index.ts';

const port = Number(process.argv[2] ?? '9877');
const dataDir = process.argv[3];
if (dataDir === undefined || !Number.isInteger(port)) {
  process.stderr.write(
    'usage: bun packages/browserhive/test/e2e/template-server.ts <port> <dataDir>\n',
  );
  process.exit(64);
}

const sites = startHttpsSites();
// The daemon must not inherit the e2e variables (the config rejects unknown BROWSERHIVE_* names).
const env = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith('BROWSERHIVE_')),
);
const server = await createServer({
  port,
  admin: true,
  dataDir,
  env,
  configFile: false,
  testing: {
    hostResolverRules: `MAP *.test:443 127.0.0.1:${sites.port}`,
    ignoreCertificateErrorsSpkiList: FIXTURE_SPKI,
  },
});
await server.listen();
process.stdout.write(`e2e-template-server: ${server.url} (fixture sites on ${sites.port})\n`);

const stop = async () => {
  await server.stop();
  sites.stop();
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
