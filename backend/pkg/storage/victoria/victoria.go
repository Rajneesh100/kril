// Package victoria pushes time-series metrics to VictoriaMetrics using
// the Prometheus remote-write compatible import API.
//
// Metrics pushed on each telemetry event:
//   kril_request_total        — counter per service/endpoint/status
//   kril_request_latency_ms   — gauge per service/endpoint
//   kril_method_error_total   — counter per service/endpoint/function
//   kril_function_latency_ms  — gauge per service/function
package victoria

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/Rajneesh100/kril/backend/pkg/storage"
)

type Client struct {
	baseURL string
	http    *http.Client
}

func New(baseURL string) (*Client, error) {
	return &Client{
		baseURL: baseURL,
		http:    &http.Client{Timeout: 5 * time.Second},
	}, nil
}

// PushMetrics writes time-series metrics for a telemetry event.
// Uses the /api/v1/import/prometheus endpoint (Prometheus text format).
func (c *Client) PushMetrics(ctx context.Context, tlog *storage.TelemetryLog) error {
	var lines []string
	ts := tlog.Timestamp.UnixMilli()

	// Request counter
	status := "success"
	if tlog.ProcessFailure {
		status = "failure"
	}
	lines = append(lines, fmt.Sprintf(
		`kril_request_total{service=%q,endpoint=%q,process_type=%q,status=%q} 1 %d`,
		tlog.ServiceName, tlog.Endpoint, tlog.ProcessType, status, ts,
	))

	// Request latency
	lines = append(lines, fmt.Sprintf(
		`kril_request_latency_ms{service=%q,endpoint=%q,process_type=%q} %f %d`,
		tlog.ServiceName, tlog.Endpoint, tlog.ProcessType, tlog.ProcessLatency, ts,
	))

	// Method failure counter
	if tlog.MethodFailure {
		lines = append(lines, fmt.Sprintf(
			`kril_method_failure_total{service=%q,endpoint=%q} 1 %d`,
			tlog.ServiceName, tlog.Endpoint, ts,
		))
	}

	// Per-function metrics
	for _, entry := range tlog.ExecutionMap {
		lines = append(lines, fmt.Sprintf(
			`kril_function_latency_ms{service=%q,function=%q,endpoint=%q} %f %d`,
			tlog.ServiceName, entry.CurrentFunction, tlog.Endpoint, entry.LatencyMs, ts,
		))

		if entry.HaveError {
			lines = append(lines, fmt.Sprintf(
				`kril_function_error_total{service=%q,function=%q,endpoint=%q} 1 %d`,
				tlog.ServiceName, entry.CurrentFunction, tlog.Endpoint, ts,
			))
		}

		for _, ec := range entry.ExternalCalls {
			callType := "service"
			if ec.URL == "database" || strings.Contains(strings.ToLower(ec.URL), "db") {
				callType = "database"
			}
			lines = append(lines, fmt.Sprintf(
				`kril_external_call_total{service=%q,function=%q,target=%q,call_type=%q} 1 %d`,
				tlog.ServiceName, entry.CurrentFunction, ec.URL, callType, ts,
			))
		}
	}

	body := strings.Join(lines, "\n") + "\n"
	url := fmt.Sprintf("%s/api/v1/import/prometheus", c.baseURL)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, strings.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "text/plain")

	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 300 {
		return fmt.Errorf("victoria metrics import failed: %d", resp.StatusCode)
	}
	return nil
}

// QueryRange queries VictoriaMetrics using PromQL.
func (c *Client) QueryRange(ctx context.Context, query, start, end, step string) ([]byte, error) {
	url := fmt.Sprintf("%s/api/v1/query_range?query=%s&start=%s&end=%s&step=%s",
		c.baseURL, query, start, end, step)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var buf [64 * 1024]byte
	n := 0
	for {
		nn, err := resp.Body.Read(buf[n:])
		n += nn
		if err != nil {
			break
		}
	}
	return buf[:n], nil
}

// QueryInstant queries VictoriaMetrics for a point-in-time PromQL result.
func (c *Client) QueryInstant(ctx context.Context, query string) ([]byte, error) {
	url := fmt.Sprintf("%s/api/v1/query?query=%s", c.baseURL, query)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var buf [64 * 1024]byte
	n := 0
	for {
		nn, err := resp.Body.Read(buf[n:])
		n += nn
		if err != nil {
			break
		}
	}
	return buf[:n], nil
}
