/** @module infra/browsers/sandboxed-frames — keeps sandboxed `srcdoc` frames in their parent's renderer process in a browser whose init scripts are a protection or an identity: a template host with stealth or "Deny clipboard writes" (spec 13 §2.1, §3.1; D18; verify #84 N1) and an exclusive stealth session (spec 11 §2.2; D-79, D58). With Chromium's `IsolateSandboxedIframes` such a frame runs out of process, no DevTools session can pause it before its first script, and the context's init scripts never reach it. Also folds every `--disable-features` switch of a command line into one (Chromium keeps only the last). */

import { launchArgKey } from '../../kernel/deny-list.ts';

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

/** Patchright's own switch, exactly as on its command line (what `ignoreDefaultArgs` must name to drop it). */
export const PATCHRIGHT_DISABLE_FEATURES_ARG = `--disable-features=${PATCHRIGHT_DISABLED_FEATURES.join(',')}`;

/** The Chromium feature that runs every sandboxed frame in a process of its own. */
export const ISOLATE_SANDBOXED_IFRAMES = 'IsolateSandboxedIframes';

/**
 * The switch as {@link sandboxedFramesArgs} adds it: `IsolateSandboxedIframes` alone. The launch
 * path folds it with every other `--disable-features` switch, Patchright's list first
 * ({@link foldDisableFeatures}), into {@link SANDBOXED_FRAMES_IN_PROCESS_ARG}.
 */
export const SANDBOXED_FRAMES_ARG = `--disable-features=${ISOLATE_SANDBOXED_IFRAMES}`;

/**
 * The switch on the command line with no other `--disable-features` to fold: Patchright's list plus
 * `IsolateSandboxedIframes`, after Patchright's own switch (Patchright appends launch `args` after
 * its defaults), from these compiled-in values only.
 */
export const SANDBOXED_FRAMES_IN_PROCESS_ARG = `--disable-features=${[
  ...PATCHRIGHT_DISABLED_FEATURES,
  ISOLATE_SANDBOXED_IFRAMES,
].join(',')}`;

/** What decides the switch: the browser's init scripts that must reach every frame. */
export interface SandboxedFramesFacts {
  /** Stealth on: `installNativeGetters` presents the identity in every frame. */
  readonly stealth: boolean;
  /** "Deny clipboard writes" on at the start: `blockPageClipboardWrites` in every frame. */
  readonly denyClipboardWrites?: boolean | undefined;
}

/**
 * The browser's switches for sandboxed frames: {@link SANDBOXED_FRAMES_ARG} when an init script
 * must reach every frame, none otherwise (Chromium's default process model). The launch path folds
 * it with the other `--disable-features` switches (`buildLaunchOptions`).
 *
 * Measured on Patchright 1.63 with Chromium 153, a sandboxed `srcdoc` frame without
 * `allow-same-origin` runs out of process and its DevTools target is attached with
 * `waitingForDebugger: false` after its first script ran, through Patchright's own auto-attach and
 * through a second one alike, so neither `Page.addScriptToEvaluateOnNewDocument` nor
 * `Runtime.evaluate` can come first. In the parent's process the context's init scripts reach it,
 * nested ones and those inside cross-site frames included.
 */
export function sandboxedFramesArgs(facts: SandboxedFramesFacts): readonly string[] {
  return facts.stealth || facts.denyClipboardWrites === true ? [SANDBOXED_FRAMES_ARG] : [];
}

/**
 * The feature list of a `--disable-features` switch in any spelling Chromium accepts (`--`, `-` or
 * `/` prefix, any letter case: {@link launchArgKey}, the deny-list's own reading), `''` for a bare
 * switch (an empty list), or `null` when `arg` is another switch or no switch.
 */
function disableFeaturesList(arg: string): string | null {
  if (launchArgKey(arg) !== DISABLE_FEATURES) return null;
  const eq = arg.indexOf('=');
  return eq === -1 ? '' : arg.slice(eq + 1).trim();
}

const DISABLE_FEATURES = '--disable-features';

/**
 * `args` with every `--disable-features` switch folded into one, last: the driver's own list (when
 * `driverSwitchKept`, i.e. `ignoreDefaultArgs` does not drop Patchright's switch), then each
 * switch's features in order, without repeats. Chromium keeps only the last `--disable-features`
 * switch, so two would silently turn the earlier one's features back on; folding keeps both lists.
 * `args` without such a switch come back unchanged (Chromium's and Patchright's defaults stand).
 */
export function foldDisableFeatures(
  args: readonly string[],
  driverSwitchKept: boolean,
): readonly string[] {
  const rest: string[] = [];
  const lists: string[] = [];
  for (const arg of args) {
    const list = disableFeaturesList(arg);
    if (list === null) rest.push(arg);
    else lists.push(list);
  }
  if (lists.length === 0) return args;
  const features = new Set<string>(driverSwitchKept ? PATCHRIGHT_DISABLED_FEATURES : []);
  for (const list of lists) {
    for (const feature of list.split(',')) {
      const name = feature.trim();
      if (name.length > 0) features.add(name);
    }
  }
  return [...rest, `--disable-features=${[...features].join(',')}`];
}

/**
 * Whether Patchright's own `--disable-features` switch stays on the command line for this
 * `ignoreDefaultArgs`: `true` drops every default, a list drops the exact strings it names.
 */
export function keepsDriverDisableFeatures(
  ignoreDefaultArgs: readonly string[] | boolean | undefined,
): boolean {
  if (ignoreDefaultArgs === true) return false;
  return !(
    Array.isArray(ignoreDefaultArgs) && ignoreDefaultArgs.includes(PATCHRIGHT_DISABLE_FEATURES_ARG)
  );
}
