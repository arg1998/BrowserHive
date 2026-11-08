---
"browserhive": minor
---

Reading pages fits in an agent's context now (#60).

- **New `get_text` tool.** Returns the readable text of a page, or of the first element matching `selector`, as plain text with line breaks. Without a selector it reads `<main>`, else the page's only `<article>`, else `<body>` without its navigation, header, footer and sidebars. Code in `<pre>` keeps its line breaks, collapsed `<details>` and inactive tab panels are included, and script, style and hidden elements are left out. It is BrowserHive's own reader rather than page script, so it works in sessions launched with `disable_evaluate: true` and on servers started with `--allowEvaluate false`, and it runs in an isolated world that page scripts cannot see or tamper with. It returns at most 20,000 characters per call.
- **`get_content`, `get_text` and `snapshot` share one paging convention.** They accept `max_chars` (up to 200,000) and `offset`, and return `total_chars`, `truncated` and `next_offset`. When `truncated` is true, call again with `offset` set to `next_offset` until it is `null`. All three also accept `selector` to read one element (`ELEMENT_NOT_FOUND` when nothing matches).
- **Behaviour change: `get_content` now returns at most 60,000 characters by default.** A larger document comes back in pages instead of one result that could overflow the MCP client. Agents that need the rest page with `offset`, raise `max_chars`, or narrow the read with `selector`. Pages under 60,000 characters come back whole as before, with three extra keys. `snapshot` pages the same way at 60,000.
- **`get_cookies` accepts `include_values: false`.** Every cookie then comes back with an empty `value`, so an agent can check which cookies are set (for example whether it is signed in) without receiving their values.
