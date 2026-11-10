/** @module browserhive/testing — the internal testing seam of `createServer` (spec 08 §9, spec 13 §14): Chromium switches that let BrowserHive's own suites use HTTPS fixture sites with `*.test` names. Not reachable from the CLI, the environment or a config file. @internal */

/** `createServer({ testing })`. @internal */
export interface ServerTesting {
  /** Chromium's `--host-resolver-rules` (e.g. `MAP *.test:443 127.0.0.1:8443`). */
  readonly hostResolverRules?: string;
  /** Chromium's `--ignore-certificate-errors-spki-list` (base64 SHA-256 of the fixture key). */
  readonly ignoreCertificateErrorsSpkiList?: string;
}

/** The Chromium switches of `testing`. @internal */
export function testingArgsOf(testing: ServerTesting | undefined): readonly string[] {
  if (testing === undefined) return [];
  return [
    ...(testing.hostResolverRules !== undefined
      ? [`--host-resolver-rules=${testing.hostResolverRules}`]
      : []),
    ...(testing.ignoreCertificateErrorsSpkiList !== undefined
      ? [`--ignore-certificate-errors-spki-list=${testing.ignoreCertificateErrorsSpkiList}`]
      : []),
  ];
}
