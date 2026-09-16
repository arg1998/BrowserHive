# Human takeover (attention requests)

Sometimes an agent needs a person: a CAPTCHA, a two-factor prompt, a judgment call. The `request_attention` tool asks an operator for help and **blocks** until the operator answers, the request times out, or it is cancelled. While it is open, the operator can watch the agent's browser and drive it directly.

Attention requests need the HTTP transport and the dashboard:

```bash
browserhive --admin
```

Under `--transport stdio`, `request_attention` and `get_attention_result` return [`ATTENTION_REQUIRES_HTTP`](../reference/errors.md#ATTENTION_REQUIRES_HTTP).

## The agent's side

```jsonc
request_attention({
  "session_id": "shop-a1b2c3d4",
  "reason": "Checkout shows a CAPTCHA. Please solve it and resolve this request.",
  "mode": "takeover",
  "max_wait_seconds": 1800
})
// blocks, then → { "status": "resolved", "message": "Done, continue.", "resolved_by": "admin", "resolved_at": 1768000000000, "request_id": "a-…" }
```

| Parameter | Meaning |
|---|---|
| `reason` | What you need; shown to the operator. |
| `mode` | `takeover` (default): the operator may drive the browser. `notify`: view only. Both block. |
| `options` | Any JSON, shown as-is to the operator (for example choices to pick from). |
| `max_wait_seconds` | `0` or absent: wait up to the server cap. Positive: at least the server floor, never above the cap. |

Outcomes:

| `status` | When |
|---|---|
| `resolved` | The operator resolved it; `message` carries their reply. |
| `rejected` | The operator rejected it, or the session closed, crashed, expired, or the server restarted or shut down (the message says which). |
| `timeout` | Nobody answered in time: "Attention request timed out; the operator was not available to respond." |
| `cancelled` | The client cancelled the call or disconnected. |

`message` and `resolved_by` are omitted when there is nothing to report.

### Waiting and reconnecting

- The server cap is `--attentionTimeout` (default `6h`). The floor is `--minAttentionWait` (default `30m`); a smaller `max_wait_seconds` is raised to it so a human has time to respond, and the tool's description tells the agent the floor. `--minAttentionWait 0` disables the floor.
- While waiting, the server sends an MCP progress notification every 25 seconds so clients and proxies keep the call alive.
- If the connection drops, the agent can call `get_attention_result({ "request_id": "a-…" })`. It returns immediately when the request is settled and otherwise blocks the same way. An unknown id, or one owned by another principal, returns `rejected` with "Unknown attention request".
- While a request is open, the session's idle lease is paused, so it is not closed for inactivity.

## The operator's side

A new request shows up as a notification, on the **Attention** page, and as a banner on the session's page.

1. Open the request. You see the reason, mode, options and how long the agent has been waiting.
2. For `takeover` requests, click **Open live & take over**. The live view accepts your mouse, wheel, keyboard and touch input and sends it to the agent's browser. Input is allowed only while this request is open and is checked on every event.
3. Type a message for the agent and click **Resolve** (done, continue) or **Reject** (the agent should give up or try something else).

Bulk resolve and reject are available when several requests are waiting. Settled requests stay in the history with outcome, wait time and who answered.

**Resize agent browser** on the live view changes the agent's real viewport. It is an observability control and does not need an open attention request.

## CAPTCHAs

`--captcha attention` (the default) documents the intended flow: an agent that hits a CAPTCHA calls `request_attention` and an operator solves it. BrowserHive does not detect or solve CAPTCHAs itself. Without `--admin` there is nobody to hand the page to; explicitly setting `--captcha attention` without `--admin` is a configuration error. `--captcha off` states that no hand-off is expected.

## Notifications and limits

- Each open request produces a persisted dashboard notification.
- At most 8 open operator requests per session and 256 in total; beyond that the call fails with [`RATE_LIMITED`](../reference/errors.md#RATE_LIMITED).
- On restart, requests that were pending become `rejected` ("Attention request was lost when the server restarted.").
