# Telemetry (OpenTelemetry)

Telemetry is **off by default**, and nothing leaves your machine unless you turn it on. With `--otel`, BrowserHive exports traces, metrics and logs over OTLP/HTTP to any compatible backend: an OpenTelemetry Collector, Grafana Tempo/Loki/Mimir, Jaeger, Honeycomb, Datadog Agent and others.

```bash
browserhive --admin --otel --otelEndpoint http://127.0.0.1:4318 --otelServiceName browserhive-dev
```

Or with standard OpenTelemetry variables:

```bash
BROWSERHIVE_OTEL=true OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 browserhive --admin
```

## Settings

| Key | Default | Meaning |
|---|---|---|
| [`otel`](../reference/configuration.md#otel) | `false` | Turn export on. |
| [`otelEndpoint`](../reference/configuration.md#otelEndpoint) | `http://127.0.0.1:4318` | OTLP/HTTP base URL; `/v1/traces`, `/v1/metrics`, `/v1/logs` are appended. Also `OTEL_EXPORTER_OTLP_ENDPOINT`. |
| [`otelProtocol`](../reference/configuration.md#otelProtocol) | `http/protobuf` | or `http/json`. Also `OTEL_EXPORTER_OTLP_PROTOCOL`. |
| [`otelHeaders`](../reference/configuration.md#otelHeaders) | none | `k=v,k2=v2`, for example an API key. Secret. Also `OTEL_EXPORTER_OTLP_HEADERS`. In the config file, keep the key itself in the environment: `{ "Authorization": "Bearer {env:OTLP_TOKEN}" }` ([references](configuration.md#references)). |
| [`otelServiceName`](../reference/configuration.md#otelServiceName) | `browserhive` | `service.name`. Also `OTEL_SERVICE_NAME`. |
| [`otelSampleRatio`](../reference/configuration.md#otelSampleRatio) | `1` | Parent-based trace sampling ratio. Also `OTEL_TRACES_SAMPLER_ARG`. |
| [`otelSignals`](../reference/configuration.md#otelSignals) | `traces,metrics,logs` | Which signals to export. |
| [`otelVerbose`](../reference/configuration.md#otelVerbose) | `false` | Also export database query and DevTools-protocol command spans. |
| [`otelTraceUrlTemplate`](../reference/configuration.md#otelTraceUrlTemplate) | unset | Dashboard deep link; `{trace_id}` is substituted. |

`BROWSERHIVE_*` variables win over `OTEL_*` ones. The `otelEndpoint`, `otelProtocol`, `otelHeaders`, `otelServiceName` and `otelSampleRatio` keys are rejected unless `otel=true`, so a typo cannot silently do nothing. When export fails five times in a row the System page shows a degradation; serving is never affected. `browserhive doctor` checks that the endpoint is reachable.

## What is exported

Resource attributes: `service.name`, `service.version`, `service.instance.id`, `host.name`, `os.type`, `browserhive.transport`.

### Traces

One trace per tool call, rooted at `mcp.tool_call` with `browserhive.tool`, `browserhive.session_id`, `browserhive.principal`, `browserhive.event_id`, `browserhive.ok` and `browserhive.error_code`. Children cover what the call did: `session.create` with one span per creation phase (validate, admit, reserve, prepare profile, resolve identity, launch, install policies, start tracing, apply identity, register), `browser.launch`, `page.navigate` (sanitized URL, status code), `vault.fill` and its steps, `attention.wait`, and with `--otelVerbose` also `db.query` and `cdp.command`. HTTP requests (`http.request`), WebSocket commands (`ws.command`), migrations (`db.migrate`) and background sweeps are traced too.

If the MCP client sends a W3C `traceparent` in the tool call's `_meta`, the tool span joins the client's trace. HTTP requests adopt an inbound `traceparent` and return one.

### Metrics

| Instrument | Type | Attributes |
|---|---|---|
| `browserhive.tool_calls` | counter | `tool`, `ok`, `error_code` |
| `browserhive.tool_call.duration` | histogram (ms) | `tool` |
| `browserhive.sessions.active` | up-down counter | `state` |
| `browserhive.session.launch.duration` | histogram (ms) | `channel`, `stealth` |
| `browserhive.session.lifetime` | histogram (ms) | `closed_reason` |
| `browserhive.ws.connections` | up-down counter | |
| `browserhive.ws.buffered_bytes` | gauge | `connection_id` |
| `browserhive.ws.frames_dropped` | counter | `channel` |
| `browserhive.db.write_queue.depth` | gauge | |
| `browserhive.db.dropped_writes` | counter | `table` |
| `browserhive.db.size_bytes` | gauge | |
| `browserhive.browser.rss_bytes` | gauge | `session_id` |
| `browserhive.attention.open` | up-down counter | `kind` |
| `browserhive.attention.wait` | histogram (ms) | `status` |
| `browserhive.vault.fills` | counter | `result` |
| `browserhive.blocklist.hits` | counter | `source` |
| `browserhive.retention.pruned_rows` | counter | `table` |
| `browserhive.process.*` | gauges | rss, heap, event-loop lag |

Metrics are exported every 30 seconds.

### Logs

Every log record, with `trace_id`, `span_id`, `request_id`, `session_id` and `principal` attached, so logs and traces correlate in your backend.

Secrets are scrubbed before export, exactly as for local logs and the database. See [Security](security.md#redaction-and-its-limits).

## Trace deep links from the dashboard

Every timeline row on a session page shows its `trace_id`. Set `--otelTraceUrlTemplate` and it becomes a link into your tracing UI:

| Backend | Template |
|---|---|
| Jaeger | `http://localhost:16686/trace/{trace_id}` |
| Grafana Tempo | a Grafana Explore URL for your Tempo data source, with `{trace_id}` as the query; copy one from Grafana ("Share → Copy link") and replace the trace id with `{trace_id}` |
| Honeycomb | `https://ui.honeycomb.io/<team>/environments/<env>/trace?trace_id={trace_id}` |

The template can be changed without a restart.

## A local stack in one directory

Grafana with Tempo (traces), Loki (logs) and Prometheus (metrics) behind an OpenTelemetry Collector. Create these files in an empty directory and run `docker compose up -d`.

`docker-compose.yml`:

```yaml
services:
  otel-collector:
    image: otel/opentelemetry-collector-contrib:latest
    command: ["--config=/etc/otelcol-contrib/config.yaml"]
    volumes: ["./otel-collector.yaml:/etc/otelcol-contrib/config.yaml:ro"]
    ports: ["4318:4318"]
    depends_on: [tempo, loki]

  tempo:
    image: grafana/tempo:latest
    command: ["-config.file=/etc/tempo.yaml"]
    volumes: ["./tempo.yaml:/etc/tempo.yaml:ro"]

  loki:
    image: grafana/loki:latest
    command: ["-config.file=/etc/loki/local-config.yaml"]

  prometheus:
    image: prom/prometheus:latest
    volumes: ["./prometheus.yml:/etc/prometheus/prometheus.yml:ro"]

  grafana:
    image: grafana/grafana:latest
    environment:
      GF_AUTH_ANONYMOUS_ENABLED: "true"
      GF_AUTH_ANONYMOUS_ORG_ROLE: Admin
    volumes: ["./grafana-datasources.yaml:/etc/grafana/provisioning/datasources/datasources.yaml:ro"]
    ports: ["3000:3000"]
    depends_on: [tempo, loki, prometheus]
```

`otel-collector.yaml`:

```yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318

processors:
  batch: {}

exporters:
  otlp/tempo:
    endpoint: tempo:4317
    tls:
      insecure: true
  otlphttp/loki:
    endpoint: http://loki:3100/otlp
  prometheus:
    endpoint: 0.0.0.0:8889

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlp/tempo]
    logs:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlphttp/loki]
    metrics:
      receivers: [otlp]
      processors: [batch]
      exporters: [prometheus]
```

`tempo.yaml`:

```yaml
server:
  http_listen_port: 3200
distributor:
  receivers:
    otlp:
      protocols:
        grpc:
          endpoint: 0.0.0.0:4317
storage:
  trace:
    backend: local
    local:
      path: /var/tempo/traces
    wal:
      path: /var/tempo/wal
```

`prometheus.yml`:

```yaml
scrape_configs:
  - job_name: otel-collector
    scrape_interval: 15s
    static_configs:
      - targets: ["otel-collector:8889"]
```

`grafana-datasources.yaml`:

```yaml
apiVersion: 1
datasources:
  - name: Prometheus
    type: prometheus
    uid: prometheus
    url: http://prometheus:9090
    isDefault: true
  - name: Tempo
    type: tempo
    uid: tempo
    url: http://tempo:3200
    jsonData:
      tracesToLogsV2:
        datasourceUid: loki
        filterByTraceID: true
  - name: Loki
    type: loki
    uid: loki
    url: http://loki:3100
```

Then:

```bash
browserhive --admin --otel --otelServiceName browserhive-dev
```

Open Grafana at `http://localhost:3000` → Explore. Pick **Tempo** and search for service `browserhive-dev` to see tool-call traces, **Loki** for logs, **Prometheus** for metrics. The Collector's Prometheus exporter converts metric names to Prometheus style, for example `browserhive.tool_calls` becomes `browserhive_tool_calls_total`.

Jaeger works the same way with less setup: `docker run -p 16686:16686 -p 4318:4318 jaegertracing/all-in-one:latest` accepts OTLP/HTTP on 4318 directly (traces only).
