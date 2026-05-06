package elastic

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/rajneesh/starfish/pkg/storage"
)

type Client struct {
	baseURL          string
	serviceLogsIndex string
	telemetryIndex   string
	http             *http.Client
}

func New(baseURL, serviceLogsIndex string) (*Client, error) {
	c := &Client{
		baseURL:          baseURL,
		serviceLogsIndex: serviceLogsIndex,
		telemetryIndex:   "telemetry_logs",
		http:             &http.Client{Timeout: 10 * time.Second},
	}
	return c, nil
}

func (c *Client) EnsureIndices(ctx context.Context) error {
	if err := c.createIndex(ctx, c.serviceLogsIndex, serviceLogMapping()); err != nil {
		return fmt.Errorf("service_logs index: %w", err)
	}
	if err := c.createIndex(ctx, c.telemetryIndex, telemetryLogMapping()); err != nil {
		return fmt.Errorf("telemetry_logs index: %w", err)
	}
	return nil
}

func (c *Client) createIndex(ctx context.Context, name string, mapping map[string]any) error {
	body, _ := json.Marshal(mapping)
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, fmt.Sprintf("%s/%s", c.baseURL, name), bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusBadRequest {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("failed to create index %s: %s", name, respBody)
	}
	return nil
}

// --- service_logs ---

func (c *Client) StoreServiceLog(ctx context.Context, log *storage.ServiceLog) error {
	return c.putDoc(ctx, c.serviceLogsIndex, log.RequestID, log)
}

func (c *Client) GetServiceLog(ctx context.Context, requestID string) (*storage.ServiceLog, error) {
	var log storage.ServiceLog
	if err := c.getDoc(ctx, c.serviceLogsIndex, requestID, &log); err != nil {
		return nil, err
	}
	return &log, nil
}

func (c *Client) SearchServiceLogs(ctx context.Context, query map[string]any) ([]storage.ServiceLog, error) {
	var logs []storage.ServiceLog
	if err := c.search(ctx, c.serviceLogsIndex, query, &logs); err != nil {
		return nil, err
	}
	return logs, nil
}

// --- telemetry_logs ---

func (c *Client) StoreTelemetryLog(ctx context.Context, log *storage.TelemetryLog) error {
	return c.putDoc(ctx, c.telemetryIndex, log.RequestID, log)
}

func (c *Client) GetTelemetryLog(ctx context.Context, requestID string) (*storage.TelemetryLog, error) {
	var log storage.TelemetryLog
	if err := c.getDoc(ctx, c.telemetryIndex, requestID, &log); err != nil {
		return nil, err
	}
	return &log, nil
}

func (c *Client) SearchTelemetryLogs(ctx context.Context, query map[string]any) ([]storage.TelemetryLog, error) {
	var logs []storage.TelemetryLog
	if err := c.search(ctx, c.telemetryIndex, query, &logs); err != nil {
		return nil, err
	}
	return logs, nil
}

// --- generic helpers ---

func (c *Client) putDoc(ctx context.Context, index, id string, doc any) error {
	body, err := json.Marshal(doc)
	if err != nil {
		return err
	}

	url := fmt.Sprintf("%s/%s/_doc/%s", c.baseURL, index, id)
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("put %s/%s failed: %s", index, id, respBody)
	}
	return nil
}

func (c *Client) getDoc(ctx context.Context, index, id string, dest any) error {
	url := fmt.Sprintf("%s/%s/_doc/%s", c.baseURL, index, id)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		return fmt.Errorf("not found: %s/%s", index, id)
	}

	var esResp struct {
		Source json.RawMessage `json:"_source"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&esResp); err != nil {
		return err
	}
	return json.Unmarshal(esResp.Source, dest)
}

func (c *Client) search(ctx context.Context, index string, query map[string]any, dest any) error {
	body, err := json.Marshal(query)
	if err != nil {
		return err
	}

	url := fmt.Sprintf("%s/%s/_search", c.baseURL, index)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}

	var esResp struct {
		Hits struct {
			Hits []struct {
				Source json.RawMessage `json:"_source"`
			} `json:"hits"`
		} `json:"hits"`
	}
	if err := json.Unmarshal(respBody, &esResp); err != nil {
		return err
	}

	// Build a JSON array from the hits and unmarshal into dest
	var items []json.RawMessage
	for _, hit := range esResp.Hits.Hits {
		items = append(items, hit.Source)
	}
	arr, _ := json.Marshal(items)
	return json.Unmarshal(arr, dest)
}

// RawSearch executes a raw ES query and returns the full response body.
func (c *Client) RawSearch(ctx context.Context, index string, query map[string]any) (json.RawMessage, error) {
	body, err := json.Marshal(query)
	if err != nil {
		return nil, err
	}

	url := fmt.Sprintf("%s/%s/_search", c.baseURL, index)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	return json.RawMessage(respBody), nil
}

func serviceLogMapping() map[string]any {
	return map[string]any{
		"settings": map[string]any{
			"number_of_shards":   1,
			"number_of_replicas": 0,
		},
		"mappings": map[string]any{
			"properties": map[string]any{
				"request_id":    map[string]string{"type": "keyword"},
				"service_name":  map[string]string{"type": "keyword"},
				"process_type":  map[string]string{"type": "keyword"},
				"endpoint":      map[string]string{"type": "keyword"},
				"timestamp":     map[string]string{"type": "date"},
				"is_successful": map[string]string{"type": "boolean"},
				"latency_ms":    map[string]string{"type": "float"},
			},
		},
	}
}

func telemetryLogMapping() map[string]any {
	return map[string]any{
		"settings": map[string]any{
			"number_of_shards":   1,
			"number_of_replicas": 0,
		},
		"mappings": map[string]any{
			"properties": map[string]any{
				"request_id":      map[string]string{"type": "keyword"},
				"service_name":    map[string]string{"type": "keyword"},
				"process_type":    map[string]string{"type": "keyword"},
				"endpoint":        map[string]string{"type": "keyword"},
				"timestamp":       map[string]string{"type": "date"},
				"method_failure":  map[string]string{"type": "boolean"},
				"process_failure": map[string]string{"type": "boolean"},
				"process_latency": map[string]string{"type": "float"},
			},
		},
	}
}
