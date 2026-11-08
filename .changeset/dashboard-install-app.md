---
"browserhive": minor
---

Install the dashboard as an app, with a help page when BrowserHive isn't running.

- **Install app** in the dashboard's account menu and command palette installs the dashboard as its own app window, with an icon in your launcher, dock or taskbar and shortcuts to Sessions, Attention and Logs. Chrome, Edge and other Chromium browsers show their own install dialog; elsewhere the dashboard shows the steps for your browser, or says plainly when the browser can't install apps (Firefox on Linux and macOS) and what to use instead. Browsers install only from a secure address: `127.0.0.1`, `localhost` or `https`.
- **When BrowserHive isn't running**, the installed app (and any browser that opened the dashboard before) shows a help page instead of the browser's "can't connect" error. It tells apart a stopped daemon, one that doesn't answer, one that is starting, a proxy whose upstream is down, an address BrowserHive refuses, an offline device and another program on the port; shows copyable commands for your OS (`browserhive --admin`, `browserhive doctor`, `browserhive config show`, what holds the port); and opens the dashboard by itself once BrowserHive is ready. **Forget this address** removes the help page for that address.
- **If BrowserHive stops while the dashboard is open**, a banner under the top bar says so after about 15–20 seconds, with **What to do** opening the same help. It clears without a reload when BrowserHive is back.
- Every daemon response now carries an `X-BrowserHive-Version` header. Without `--admin`, a browser navigation to any dashboard path shows the status page (HTTP 404 off `/`) instead of a JSON error, so an installed app explains itself.
- The page's small service worker stores only the help page's own public files (no API data, no operator data) and never touches `/api`, `/mcp`, `/health` or `/trace-viewer`. It removes itself when another program answers on the address.
