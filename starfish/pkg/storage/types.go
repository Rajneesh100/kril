package storage

import "time"

// ServiceLog is the full log record stored in Elasticsearch.
type ServiceLog struct {
	RequestID     string          `json:"request_id"`
	ServiceName   string          `json:"service_name"`
	ProcessType   string          `json:"process_type"`
	Endpoint      string          `json:"endpoint"`
	Timestamp     time.Time       `json:"timestamp"`
	IsSuccessful  bool            `json:"is_successful"`
	LatencyMs     float64         `json:"latency_ms"`
	ExecutionFlow []FunctionTrace `json:"execution_flow"`
}

type FunctionTrace struct {
	Index           int            `json:"index"`
	CurrentFunction string         `json:"current_function"`
	ParentFunction  string         `json:"parent_function"`
	Input           string         `json:"input"`
	Output          string         `json:"output"`
	LatencyMs       float64        `json:"latency_ms"`
	HaveError       bool           `json:"have_error"`
	Logs            []LogEntry     `json:"logs"`
	ExternalCalls   []ExternalCall `json:"external_calls"`
}

type LogEntry struct {
	Timestamp string `json:"timestamp"`
	Level     string `json:"level"`
	Message   string `json:"message"`
}

type ExternalCall struct {
	URL string `json:"url"`
}

// TelemetryLog is the lightweight record stored in VictoriaMetrics/time-series DB.
type TelemetryLog struct {
	RequestID      string              `json:"request_id"`
	Timestamp      time.Time           `json:"timestamp"`
	ServiceName    string              `json:"service_name"`
	ProcessType    string              `json:"process_type"`
	Endpoint       string              `json:"endpoint"`
	MethodFailure  bool                `json:"method_failure"`
	ProcessFailure bool                `json:"process_failure"`
	ProcessLatency float64             `json:"process_latency"`
	ExecutionMap   []ExecutionMapEntry `json:"execution_map"`
}

type ExecutionMapEntry struct {
	Index           int            `json:"index"`
	CurrentFunction string         `json:"current_function"`
	ParentFunction  string         `json:"parent_function"`
	LatencyMs       float64        `json:"latency_ms"`
	HaveError       bool           `json:"have_error"`
	ExternalCalls   []ExternalCall `json:"external_calls"`
}
