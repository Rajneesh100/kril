package analytics

import (
	"encoding/json"
	"io"
	"net/http"
	"time"

	"github.com/Rajneesh100/kril/backend/pkg/storage/elastic"
	"github.com/Rajneesh100/kril/backend/pkg/storage/victoria"
)

type Router struct {
	mux *http.ServeMux
	es  *elastic.Client
	vm  *victoria.Client
}

func NewRouter(es *elastic.Client, vm *victoria.Client) *Router {
	r := &Router{
		mux: http.NewServeMux(),
		es:  es,
		vm:  vm,
	}
	r.mux.HandleFunc("GET /api/health", r.health)
	r.mux.HandleFunc("GET /api/services", r.listServices)
	r.mux.HandleFunc("GET /api/service-logs/{requestID}", r.getServiceLog)
	r.mux.HandleFunc("GET /api/telemetry-logs", r.queryTelemetryLogs)
	r.mux.HandleFunc("GET /api/telemetry-logs/{requestID}", r.getTelemetryLog)
	r.mux.HandleFunc("GET /api/execution-map", r.getExecutionMap)
	r.mux.HandleFunc("GET /api/metrics/query", r.metricsQuery)
	r.mux.HandleFunc("GET /api/metrics/query_range", r.metricsQueryRange)
	return r
}

func (r *Router) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	// CORS
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	if req.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}
	r.mux.ServeHTTP(w, req)
}

func (r *Router) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (r *Router) listServices(w http.ResponseWriter, req *http.Request) {
	query := map[string]any{
		"size": 0,
		"aggs": map[string]any{
			"services": map[string]any{
				"terms": map[string]any{
					"field": "service_name",
					"size":  100,
				},
			},
		},
	}

	raw, err := r.es.RawSearch(req.Context(), "telemetry_logs", query)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	var esResp struct {
		Aggregations struct {
			Services struct {
				Buckets []struct {
					Key string `json:"key"`
				} `json:"buckets"`
			} `json:"services"`
		} `json:"aggregations"`
	}
	if err := json.Unmarshal(raw, &esResp); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	services := make([]string, 0, len(esResp.Aggregations.Services.Buckets))
	for _, b := range esResp.Aggregations.Services.Buckets {
		services = append(services, b.Key)
	}
	writeJSON(w, http.StatusOK, services)
}

func (r *Router) getServiceLog(w http.ResponseWriter, req *http.Request) {
	requestID := req.PathValue("requestID")
	log, err := r.es.GetServiceLog(req.Context(), requestID)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, log)
}

func (r *Router) queryTelemetryLogs(w http.ResponseWriter, req *http.Request) {
	serviceName := req.URL.Query().Get("service_name")
	fromStr := req.URL.Query().Get("from")
	toStr := req.URL.Query().Get("to")

	filters := []map[string]any{}
	if serviceName != "" {
		filters = append(filters, map[string]any{
			"term": map[string]any{"service_name": serviceName},
		})
	}

	if fromStr != "" || toStr != "" {
		rangeFilter := map[string]any{}
		if fromStr != "" {
			if t, err := time.Parse(time.RFC3339, fromStr); err == nil {
				rangeFilter["gte"] = t.Format(time.RFC3339)
			}
		}
		if toStr != "" {
			if t, err := time.Parse(time.RFC3339, toStr); err == nil {
				rangeFilter["lte"] = t.Format(time.RFC3339)
			}
		}
		if len(rangeFilter) > 0 {
			filters = append(filters, map[string]any{
				"range": map[string]any{"timestamp": rangeFilter},
			})
		}
	}

	query := map[string]any{
		"size": 1000,
		"sort": []map[string]any{{"timestamp": "desc"}},
	}
	if len(filters) > 0 {
		query["query"] = map[string]any{
			"bool": map[string]any{"filter": filters},
		}
	}

	logs, err := r.es.SearchTelemetryLogs(req.Context(), query)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, logs)
}

func (r *Router) getTelemetryLog(w http.ResponseWriter, req *http.Request) {
	requestID := req.PathValue("requestID")
	log, err := r.es.GetTelemetryLog(req.Context(), requestID)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, log)
}

// getExecutionMap returns an overlaid execution map for a service in a time range.
// It aggregates all execution_maps and computes edge frequency + error rates.
func (r *Router) getExecutionMap(w http.ResponseWriter, req *http.Request) {
	serviceName := req.URL.Query().Get("service_name")
	fromStr := req.URL.Query().Get("from")
	toStr := req.URL.Query().Get("to")

	if serviceName == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "service_name is required"})
		return
	}

	filters := []map[string]any{
		{"term": map[string]any{"service_name": serviceName}},
	}

	rangeFilter := map[string]any{}
	if fromStr != "" {
		if t, err := time.Parse(time.RFC3339, fromStr); err == nil {
			rangeFilter["gte"] = t.Format(time.RFC3339)
		}
	}
	if toStr != "" {
		if t, err := time.Parse(time.RFC3339, toStr); err == nil {
			rangeFilter["lte"] = t.Format(time.RFC3339)
		}
	}
	if len(rangeFilter) > 0 {
		filters = append(filters, map[string]any{
			"range": map[string]any{"timestamp": rangeFilter},
		})
	}

	query := map[string]any{
		"size": 10000,
		"query": map[string]any{
			"bool": map[string]any{"filter": filters},
		},
	}

	logs, err := r.es.SearchTelemetryLogs(req.Context(), query)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	// Aggregate: build a graph of function nodes and edges
	type NodeStats struct {
		Function      string   `json:"function"`
		TotalCalls    int      `json:"total_calls"`
		ErrorCount    int      `json:"error_count"`
		AvgLatencyMs  float64  `json:"avg_latency_ms"`
		IsEntryPoint  bool     `json:"is_entry_point"`
		ExternalCalls []string `json:"external_calls,omitempty"`
	}
	type EdgeStats struct {
		From  string `json:"from"`
		To    string `json:"to"`
		Count int    `json:"count"`
	}

	nodeMap := map[string]*NodeStats{}
	edgeMap := map[string]*EdgeStats{}

	for _, tlog := range logs {
		for _, entry := range tlog.ExecutionMap {
			fn := entry.CurrentFunction

			node, ok := nodeMap[fn]
			if !ok {
				node = &NodeStats{Function: fn}
				nodeMap[fn] = node
			}
			node.TotalCalls++
			if entry.HaveError {
				node.ErrorCount++
			}
			node.AvgLatencyMs += entry.LatencyMs
			if entry.ParentFunction == "" {
				node.IsEntryPoint = true
			}
			for _, ec := range entry.ExternalCalls {
				node.ExternalCalls = append(node.ExternalCalls, ec.URL)
			}

			if entry.ParentFunction != "" {
				edgeKey := entry.ParentFunction + "->" + fn
				edge, ok := edgeMap[edgeKey]
				if !ok {
					edge = &EdgeStats{From: entry.ParentFunction, To: fn}
					edgeMap[edgeKey] = edge
				}
				edge.Count++
			}
		}
	}

	// Finalize averages
	nodes := make([]*NodeStats, 0, len(nodeMap))
	for _, n := range nodeMap {
		if n.TotalCalls > 0 {
			n.AvgLatencyMs /= float64(n.TotalCalls)
		}
		// Deduplicate external calls
		seen := map[string]bool{}
		deduped := []string{}
		for _, ec := range n.ExternalCalls {
			if !seen[ec] {
				seen[ec] = true
				deduped = append(deduped, ec)
			}
		}
		n.ExternalCalls = deduped
		nodes = append(nodes, n)
	}

	edges := make([]*EdgeStats, 0, len(edgeMap))
	for _, e := range edgeMap {
		edges = append(edges, e)
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"service_name":   serviceName,
		"total_requests": len(logs),
		"nodes":          nodes,
		"edges":          edges,
	})
}

// metricsQuery proxies PromQL instant queries to VictoriaMetrics.
// GET /api/metrics/query?query=<promql>
func (r *Router) metricsQuery(w http.ResponseWriter, req *http.Request) {
	if r.vm == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "VictoriaMetrics not configured"})
		return
	}
	query := req.URL.Query().Get("query")
	if query == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "query parameter is required"})
		return
	}
	data, err := r.vm.QueryInstant(req.Context(), query)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Write(data)
}

// metricsQueryRange proxies PromQL range queries to VictoriaMetrics.
// GET /api/metrics/query_range?query=<promql>&start=<ts>&end=<ts>&step=<duration>
func (r *Router) metricsQueryRange(w http.ResponseWriter, req *http.Request) {
	if r.vm == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "VictoriaMetrics not configured"})
		return
	}
	query := req.URL.Query().Get("query")
	start := req.URL.Query().Get("start")
	end := req.URL.Query().Get("end")
	step := req.URL.Query().Get("step")
	if query == "" || start == "" || end == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "query, start, end are required"})
		return
	}
	if step == "" {
		step = "60s"
	}
	data, err := r.vm.QueryRange(req.Context(), query, start, end, step)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Write(data)
}

func writeJSON(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}

// suppress unused import
var _ = io.EOF
