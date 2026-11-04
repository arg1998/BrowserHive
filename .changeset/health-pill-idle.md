---
"browserhive": patch
---

The dashboard's connection pill no longer turns **Degraded** when a page is left idle. It used to count "no request in the last 30 seconds" as a REST failure, so quiet pages such as System or Settings flipped to Degraded after about half a minute and back to Live on the next click. It also compared a browser timestamp with a server-anchored one, so clock skew between host and browser shifted that window.

- REST is now marked failing only when a request actually fails: a network error, a timeout, or a 5xx where the daemon could not answer (for example a proxy's 502). 4xx answers and failed operations the daemon reports (a navigation that failed, a channel test the platform refused) do not count.
- The next successful request clears it. While failing, the dashboard checks `GET /health` every 15 seconds, so a single blip on a quiet page clears itself.
- The popover shows when the daemon last answered ("2m ago") and, when REST is failing, why ("Failing (network error)").
