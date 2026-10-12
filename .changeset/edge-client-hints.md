---
"browserhive": patch
---

Microsoft Edge under stealth now presents itself as Microsoft Edge.

- **Client hints match the browser.** With `channel: "edge"` and stealth on, `navigator.userAgentData` used to say `Google Chrome` (with Edge's version as the Chromium version) while the user agent said `Edg/`, a mismatch sites can check. BrowserHive now uses Edge's own client hints: `Microsoft Edge` at Edge's version, `Chromium` at the real Chromium version underneath, and Edge's own GREASE entry, exactly what real Edge sends. Chrome and the bundled Chromium are unchanged.
- **Checked on every run.** The stealth checks (`sandbox-matrix` and the sandbox parity test) now assert per channel that the vendor brand appears once, the other vendor never, and that brands, user agent and versions agree.
