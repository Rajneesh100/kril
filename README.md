# kril

**Open-source Go observability with a built-in AI debugger.**

Drop-in context wrapper for Go services. Every request traces itself — function tree, latency, inputs, outputs, errors — and streams to a self-hosted backend over gRPC. Visualize live service graphs, get Slack alerts on thresholds, and let kril's RCA agent post root-cause hypotheses the moment something breaks.

No SDK sprawl. No vendor lock-in. Apache 2.0.

---

## Quickstart

You need **Docker** and **Docker Compose**. That's it.

```bash
# 1. Clone
git clone https://github.com/Rajneesh100/kril.git
cd kril

# 2. Bring up the whole stack (backend, UI, storage, demo services)
docker compose up -d

# 3. Generate some traffic
./test_services/loadgen.sh 200 100

# 4. Open the dashboard
open http://localhost:3000
```

That's the full setup. No Go install, no Node install, no manual config.

### What just started

| Service           | Port  | What it does                                  |
| ----------------- | ----- | --------------------------------------------- |
| kril UI           | 3000  | Dark glass-UI dashboard (service graph)       |
| kril backend      | 50051 | gRPC `/push-metric` ingest + REST analytics   |
| Elasticsearch     | 9200  | Raw request logs (hot 7d, then cold archive)  |
| VictoriaMetrics   | 8428  | Time-series metrics (rps, latency, errors)    |
| Demo service A    | 8081  | Calls B and C — generates a realistic graph   |
| Demo service B    | 8082  | Returns user data, calls DB                   |
| Demo service C    | 8083  | Order service, intentionally flaky for demos  |

### Stop / reset

```bash
docker compose down          # stop
docker compose down -v       # stop + wipe all data
```

---

## Instrument your own service

Once kril is running, point your Go service at it with two lines.

```go
import "github.com/Rajneesh100/kril/backend/pkg/ctx"

func main() {
    ctx.Init(ctx.Config{
        ServiceName:  "my-service",
        KrilEndpoint: "localhost:50051",
    })
}
```

Then use `ctx.New` instead of `context.Background` at request entry points:

```go
func Handler(w http.ResponseWriter, r *http.Request) {
    c := ctx.New(r.Context(), "GET /users", ctx.TypeAPI)
    defer c.Flush()

    user, err := fetchUser(c, r.URL.Query().Get("id"))
    // ...
}

func fetchUser(c ctx.Ctx, id string) (*User, error) {
    c = c.Child("fetchUser")
    defer c.Done()
    // your code — c.Log(), c.SetInput(), c.SetOutput() as needed
}
```

Function tree, latency, errors, and external calls are captured automatically and shipped async over gRPC. Zero impact on hot-path performance.

---

## Architecture

```
   your services ──► ctx module ──gRPC──►  kril backend
                                              │
                              ┌───────────────┼───────────────┐
                              ▼               ▼               ▼
                         Elasticsearch  VictoriaMetrics    Slack
                         (raw logs)      (time-series)    (alerts + RCA)
                              │               │
                              └──────┬────────┘
                                     ▼
                                  kril UI
                          (service graph + analytics)
```

- **`pkg/ctx`** — drop-in Go context that records the function tree, inputs/outputs, latency, logs, errors, and external calls per request. Fire-and-forget async dispatch.
- **kril backend** — gRPC ingest on `/push-metric`. Splits each payload into raw logs (Elastic, keyed by `{service_name, request_id}`) and a slim time-series record (VictoriaMetrics) for analytics.
- **kril UI** — dark glass UI. Service bubbles, function nodes (4u root, 2u children), edge thickness = call frequency, node shade red = error rate. Pick a time range, pick a service, see the graph.
- **Alerts** — configure thresholds (max rps, min rps, error %, latency) per service or per function. Slack delivery.
- **RCA agent** — at 50% of any configured alert threshold, the agent pulls failing request logs from Elastic plus your deployed git branch, and posts a root-cause hypothesis to the same Slack channel.

---

## Configuration

All config lives in `config.yaml` at the project root and is read by the backend container at startup.

```yaml
backend:
  grpc_port: 50051
  http_port: 8080

storage:
  elastic_url: http://elasticsearch:9200
  victoria_url: http://victoriametrics:8428
  hot_retention_days: 7
  cold_archive: s3://...    # optional

alerts:
  slack_webhook: ""         # paste your webhook here
  default_channel: "#alerts"

rca:
  enabled: true
  git_repo: ""              # path or URL — agent reads source for root-cause hypotheses
  trigger_at_pct: 50        # fire at 50% of alert threshold
```

Restart the backend container after changes: `docker compose restart kril-backend`.

---

## Project layout

```
kril/
├── backend/           Go — gRPC ingest, storage, analytics APIs
│   ├── cmd/kril       entrypoint
│   ├── pkg/ctx        the drop-in context module (import this in your services)
│   ├── pkg/telemetry  gRPC server
│   ├── pkg/storage    Elastic + VictoriaMetrics writers
│   └── pkg/analytics  REST APIs powering the UI
├── ui/                React + TypeScript, dark glass UI
├── test_services/     three demo services (a, b, c) + load generator
└── docker-compose.yml one-command stack
```

---

## Roadmap

- [x] **M1** — `ctx` module, gRPC ingest, Elastic + VictoriaMetrics storage
- [x] **M2** — Analytics APIs + dark glass-UI service graph
- [x] **M3** — Demo services + load generator
- [ ] **M4** — Alerts module (threshold config + Slack delivery)
- [ ] **M5** — kril buddy: LLM-powered RCA agent posting to Slack

---

## Contributing

Issues and PRs welcome. Good-first-issue labels are kept current. If you're building something kril doesn't cover yet, open an issue describing the use case before sending a PR — the project is opinionated about staying minimal-intrusion.

---

## License

Apache 2.0.
