---
"browserhive": patch
---

The System page's **MCP connections** list now shows 10 connections per page, with the usual pager underneath (10, 25 or 50 rows per page, previous/next, "1–10 of 23"). Before, it showed up to 50 at once with no way to see older ones. For API clients, `GET /api/v1/system/mcp/connections` accepts an `offset` for paging and returns `total`, the number of stored connections; existing calls behave exactly as before.
