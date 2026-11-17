/** @module infra/browsers/sandboxed-frames — keeps sandboxed `srcdoc` frames in their parent's renderer process on a template host whose init scripts are a protection or an identity (spec 13 §2.1, §3.1; D18; verify #84 N1): with Chromium's `IsolateSandboxedIframes` such a frame runs out of process, no DevTools session can pause it before its first script, and the context's init scripts never reach it. */

/**
 * Patchright 1.63's own `--disable-features` list (`chromiumSwitches.ts`, always on its command
 * line). Chromium keeps only the last `--disable-features` switch (measured on Chromium 153: an
 * extra one alone turns `ThirdPartyStoragePartitioning` back on), so ours repeats the whole list.
 * `sandboxed-frames.test.ts` compares it with the installed Patchright on every run.
 */
export const PATCHRIGHT_DISABLED_FEATURES: readonly string[] = [
  'AvoidUnnecessaryBeforeUnloadCheckSync',
  'DestroyProfileOnBrowserClose',
  'DialMediaRouteProvider',
  'GlobalMediaControls',
  'HttpsUpgrades',
  'LensOverlay',
  'MediaRouter',
  'PaintHolding',
  'ThirdPartyStoragePartitioning',
  'BlockOriginHeaderModificationOnRedirect',
  'Translate',
  'AutoDeElevate',
  'OptimizationHints',
  'msForceBrowserSignIn',
  'msEdgeUpdateLaunchServicesPreferredVersion',
];

/** The Chromium feature that runs every sandboxed frame in a process of its own. */
export const ISOLATE_SANDBOXED_IFRAMES = 'IsolateSandboxedIframes';

/**
 * The switch, from this compiled-in value only: Patchright's list plus `IsolateSandboxedIframes`.
 * It must come after Patchright's own switch (Patchright appends launch `args` after its defaults).
 */
export const SANDBOXED_FRAMES_IN_PROCESS_ARG = `--disable-features=${[
  ...PATCHRIGHT_DISABLED_FEATURES,
  ISOLATE_SANDBOXED_IFRAMES,
].join(',')}`;

/** What decides the switch: the host's init scripts that must reach every frame. */
export interface SandboxedFramesFacts {
  /** Stealth on: `installNativeGetters` presents the identity in every frame. */
  readonly stealth: boolean;
  /** "Deny clipboard writes" on at the start: `blockPageClipboardWrites` in every frame. */
  readonly denyClipboardWrites?: boolean | undefined;
}

/**
 * The host's switches for sandboxed frames: {@link SANDBOXED_FRAMES_IN_PROCESS_ARG} when an init
 * script must reach every frame, none otherwise (Chromium's default process model).
 *
 * Measured on Patchright 1.63 with Chromium 153, a sandboxed `srcdoc` frame without
 * `allow-same-origin` runs out of process and its DevTools target is attached with
 * `waitingForDebugger: false` after its first script ran, through Patchright's own auto-attach and
 * through a second one alike, so neither `Page.addScriptToEvaluateOnNewDocument` nor
 * `Runtime.evaluate` can come first. In the parent's process the context's init scripts reach it,
 * nested ones and those inside cross-site frames included.
 */
export function sandboxedFramesArgs(facts: SandboxedFramesFacts): readonly string[] {
  return facts.stealth || facts.denyClipboardWrites === true
    ? [SANDBOXED_FRAMES_IN_PROCESS_ARG]
    : [];
}
