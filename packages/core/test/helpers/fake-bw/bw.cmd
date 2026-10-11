@echo off
rem Windows shim so the fake `bw` can sit on PATH (bw.cmd, like an npm-installed Bitwarden CLI); the behaviour lives in fake-bw.ts.
bun "%~dp0fake-bw.ts" %*
