## What / why

<!-- one paragraph; link the issue -->

## Decisions

<!-- D-xx implemented or affected; a changed decision edits specs/00-decisions.md in this PR -->

## Contract changes

<!-- every changed tool/route/WS message/config key/DB migration; golden diff summary; additive or breaking -->

## Test evidence

<!-- suites; CI run link for integration/e2e -->

## Screenshots

<!-- dashboard changes: 390 px and ≥1280 px, light and dark -->

## Changeset

<!-- present, or `no-changeset` with reason -->

## Checklist

- [ ] `bun run check` passes locally
- [ ] behavior tested at the outermost observable surface
- [ ] contracts/goldens/docs/changeset updated for wire changes
- [ ] no new `any`, payload casts, `!`, `String(err)`, silent catch, floating promise, `process.env`, module-level mutable state
- [ ] TSDoc on exports, `@module` headers, "why" comments on constants
- [ ] new dependencies justified, license allowed, pinned per policy
- [ ] dashboard: keyboard-operable, tokens only, both themes, screenshots attached
- [ ] `D-xx` references added where code implements a decision
