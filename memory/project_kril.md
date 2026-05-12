---
name: kril project
description: Open-source rebrand of the "starfish" observability system in goal.md — Go-context-based tracing, gRPC ingest, Elastic+VictoriaMetrics, dark glass-UI, alerts, AI RCA agent
type: project
---

The observability system described in goal.md (originally named "starfish" / "starfish-ui") is being released as an open-source project under the name **kril**. LinkedIn page created 2026-05-12.

Architecture in short:
- `ctx` Go module — drop-in replacement for stdlib context that records function tree, latency, I/O, logs, errors per request
- gRPC `/push-metric` ingest service (kril backend, formerly "starfish")
- Storage: Elastic for raw logs (service+request_id keyed, 7-day hot → cold archival), VictoriaMetrics for time-series `telemetry_logs` powering analytics
- `kril-ui` (formerly `starfish-ui`) — dark-mode glass UI showing service bubbles, function nodes (4u root, 2u children), edge thickness = call frequency, red shade = error rate
- Alerts module — threshold-based, Slack delivery (creds pending from user)
- "starfish buddy" AI agent — at 50% of alert threshold, pulls logs + git deployed branch, posts RCA suggestion to Slack

**Why:** User is launching this publicly and wants community traction; positioning is "minimal-intrusion Go observability with built-in AI debugger."

**How to apply:** When user references "kril" they mean this project. The codebase folder may still use "starfish" naming internally — don't assume rename has been propagated to code yet. If asked to update branding, check both names.
