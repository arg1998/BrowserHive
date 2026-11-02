---
"browserhive": patch
---

Installing BrowserHive now also gives you `bh`, a shorthand for the `browserhive` command: `bh init`, `bh doctor` and `bh --admin` work exactly like the full name. It is a second `bin` entry for the same file, so a global npm, pnpm or Bun install creates both commands (on Windows, the `.cmd` and `.ps1` shims for npm and the `.exe` launcher for Bun).

- `browserhive` stays the documented name: help text, error messages and the docs keep using it, and scripts, CI jobs and MCP client configurations should too, since `bh` may be something else on another machine.
- `browserhive doctor` has a new `bh` row. It warns (exit code 2) when the first `bh` on `PATH` is not BrowserHive's, for example a script of your own, and names its path. It is never a failure, and it is fine when there is no `bh` at all. Shell aliases and functions are not visible to `doctor`; `type -a bh` or `Get-Command bh -All` lists them.
