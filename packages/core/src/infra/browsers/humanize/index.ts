/** @module infra/browsers/humanize — named exports of the humanize layer (see NOTICE.md for attribution). */

export {
  type ActionContext,
  type ActionLocator,
  type ActionPage,
  BUDGET_FRACTION,
  estimateTypingMs,
  type HumanClickParams,
  type HumanHoverParams,
  type HumanScrollParams,
  type HumanTypeParams,
  humanClick,
  humanHover,
  humanScroll,
  humanType,
  MAX_HUMANIZED_CHARS,
  moveTo,
  POINTER_ESTIMATE_MS,
  withinBudget,
} from './actions.ts';
export type { CubicBezier, Vector } from './bezier.ts';
export { type Sleep, sleep } from './clock.ts';
export {
  type BoundingBox,
  type ClickOptions,
  type CursorMouse,
  type CursorOptions,
  type CursorPage,
  CursorTracker,
  clickBox,
  DEFAULT_INTER_CLICK,
  DEFAULT_PRESS_DWELL,
  DEFAULT_SCROLL_CHUNKS,
  DEFAULT_SCROLL_PAUSE,
  hoverBox,
  type MouseButton,
  type ScrollOptions,
  type Size,
  scrollBy,
} from './cursor.ts';
export {
  DEFAULT_OPTIONS as DEFAULT_PATH_OPTIONS,
  humanPath,
  type PathOptions,
  type PathStep,
  pointInsideBox,
} from './path.ts';
export { hashSeed, type Rng, seededRng, systemRng } from './rng.ts';
export {
  DEFAULT_TYPING_OPTIONS,
  fitToBudget,
  performTyping,
  planDuration,
  planTyping,
  type TypingAction,
  type TypingKeyboard,
  type TypingOptions,
} from './typing.ts';
export {
  createVaultHumanTyper,
  type HumanTyper,
  type VaultHumanTyperDeps,
  type VaultTyperOptions,
  type VaultTyperPage,
} from './vault-typer.ts';
