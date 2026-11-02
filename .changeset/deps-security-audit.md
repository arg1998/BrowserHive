---
"browserhive": patch
---

Security updates for dependencies with high-severity advisories, and size limits on `/mcp`.

- **MCP SDK 1.30.0 → 1.32.2.** Request bodies the MCP transport reads are capped at 4 MiB (HTTP 413) and JSON-RPC batches at 100 messages (HTTP 400), GHSA-f897-62hf-6gxq. The `initialize` body, which BrowserHive reads itself, now has the same 4 MiB cap; before, it had none.
- **Tool-input element cap.** A tool call whose arguments hold more than 100,000 array elements and object members fails with `INVALID_ARGUMENTS` before it is validated, so one request cannot exhaust memory during validation (GHSA-46jr-4wx8-v453). Real inputs are far below the cap.
- **zod 4.6.5 → 4.6.7** (GHSA-mrhx-c7xc-m3w5) and **hono 4.13.8 → 4.13.11**. The MCP SDK's own `express`/`body-parser` (GHSA-27r3-jxmh-p828) are updated with it.
