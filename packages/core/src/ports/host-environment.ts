/** @module ports/host-environment — injected host facts; the only path by which `process.env`-derived values reach core (spec 05 §4.2). */

/** Environment variables and host descriptors core is allowed to know about. */
export interface HostEnvironment {
  readonly platform: 'darwin' | 'win32' | 'linux' | string;
  readonly arch: string;
  readonly release: string;
  readonly homeDir: string;
  readonly tmpDir: string;
  readonly totalMemoryBytes: number;
  readonly cpuCount: number;
  readonly isTty: { readonly stdout: boolean; readonly stderr: boolean };
  /** Selected env vars (`LC_ALL`, `LANG`, `DISPLAY`, `NO_COLOR`, `FORCE_COLOR`, `TERM`, `BW_SESSION`, `PATH`, `XDG_DATA_HOME`, `LOCALAPPDATA`, `PLAYWRIGHT_BROWSERS_PATH`…). */
  readonly env: Readonly<Record<string, string | undefined>>;
}
