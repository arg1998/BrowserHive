---
"browserhive": patch
---

Page-side errors, downloads and reads during a navigation no longer come back as `INTERNAL_ERROR` (#55, #56).

- **`evaluate`** answers `SCRIPT_ERROR` with the page's message again (for example `TypeError: Cannot read properties of null (reading 'x')` or `TypeError: Failed to fetch`). Playwright 1.63 changed the wording of driver errors (`evaluate: …` instead of `page.evaluate: …`), and the error mapping only knew the old form. Download, upload and navigation-timeout errors were checked the same way.
- **`evaluate` auto-wrap** now parses the expression instead of counting brackets. An expression that is exactly one function (`() => …`, `x => …`, `async () => …`, `function () {}`) is still called for you; anything else runs as written. An IIFE that is already invoked is never wrapped again, even when it contains `(` or `)` inside a string, template, regex or comment, so `(() => { const s = 'start('; return s.length; })()` returns `6`. Invalid code is passed through, so you get the page's own `SyntaxError`.
- **`get_content`** while the tab is still navigating (for example right after a `navigate` that timed out) waits up to 5 s for the new page and reads again. If the page is still navigating, it answers `WAIT_TIMEOUT` ("waiting for the page to finish navigating"), which is safe to retry.
- **`navigate` and `new_tab` to a URL that is a download** (`Content-Disposition: attachment`) now save the file into the session's downloads folder, like `download_file`, and succeed. The result keeps the tab's URL, has `status: null`, and adds a `download` field with `saved_to`, `suggested_name` and `size`. The download counts against the call's `timeout`; a download that fails or does not finish in time answers `DOWNLOAD_FAILED`.
