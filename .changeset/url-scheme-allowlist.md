---
'browserhive': patch
---

`navigate` and `new_tab` now open only web URLs: `http://`, `https://`, `about:blank` and `data:`. Any other scheme is refused with the new error `URL_SCHEME_NOT_ALLOWED` (400, retry with different arguments) before the browser is touched. That covers `file:`, `view-source:`, `chrome:`, `chrome-untrusted:`, `chrome-extension:`, `devtools:`, `javascript:`, `blob:`, `filesystem:`, `mailto:`, `about:` pages other than `about:blank`, and app schemes. Before this change these URLs reached the browser: `file:` read local files, `chrome:` pages exposed browser settings and history, and a `javascript:` URL ran script in the page even in a session launched with `disable_evaluate: true`, while the tool reported a navigation failure.

Behaviour changes:

- Input without a scheme is refused instead of passed to the browser. Write `example.com` as `https://example.com/` and `localhost:3000` as `http://localhost:3000/`.
- The browser is given the normalized URL (`HTTPS://Example.COM` opens `https://example.com/`), so case, whitespace, tabs and newlines cannot hide a scheme.
- A `new_tab` call with a refused URL opens no tab.
- As a backstop, a tab whose page ends up on a non-web URL without a tool asking for it is closed, and the server logs `non-web scheme page closed` with the session id and scheme. Pages a site opens as `blob:` or `data:` documents, `about:srcdoc` frames, Chromium's error page and downloads are unaffected.

The `navigate` and `new_tab` tool descriptions say which URLs can be opened, and the security guide has a new section on it. The blocklist still covers network schemes only.
