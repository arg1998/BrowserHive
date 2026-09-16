# Third-party attribution — `humanize/`

The code in this directory is original to BrowserHive. No third-party source is vendored, and no
runtime dependency is taken (the cubic-Bézier geometry in `bezier.ts` is written from the closed-form
algebra rather than pulling in `bezier-js`).

Two things here are nonetheless **derived** from prior art and are credited accordingly.

## ghost-cursor — MIT

- <https://github.com/Xetera/ghost-cursor> — MIT, Copyright (c) 2021 Xetera
- <https://github.com/ReaZzy/ghost-cursor-playwright> — MIT, Copyright (c) 2026 ReaZ
  (the Playwright fork; note its `package.json` declares ISC while the `LICENSE` file is MIT — both
  are permissive and the `LICENSE` file governs)

`path.ts` reuses ghost-cursor's **path-shaping model and its numeric constants**: the two randomly
perpendicular-offset Bézier anchors, the `[2, 200]` px spread clamp, the Fitts's-law index of
difficulty `2·log₂(distance / width + 1)` with `width = 100`, the step-count formula
`ceil((log₂(ID + 1) + rand·25) · 3)`, and the overshoot pair (`500` px threshold, `120` px radius).

Not taken from it: the **timing model**. ghost-cursor stamps synthetic timestamps onto CDP
`Input.dispatchMouseEvent` payloads, which Playwright's `page.mouse` has no parameter for, so the
cadence here is a minimum-jerk velocity profile driving real wall-clock sleeps — see `path.ts`.

Also not taken: the debug mouse-helper and the main-world position/target trackers, which inject DOM
nodes and run `page.evaluate` in the main world on every load. Both would newly trip the very
`mainWorldExecution` detection the patched driver exists to avoid.

## Keystroke model

`typing.ts` is original. Neither reference humanizer models typing at all. The log-normal
inter-keystroke distribution is the standard model for human keystroke timing; the QWERTY adjacency
table is common knowledge about keyboard layout, not a port of anyone's code.

## Deliberately not used

**Camoufox** (`MouseTrajectories.hpp`) is MPL-2.0, which is file-level copyleft — copying it would
put a reciprocal-licensing obligation on this file. No Camoufox code is present here, directly or by
transcription.
