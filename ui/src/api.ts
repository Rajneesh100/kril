const API_BASE = process.env.REACT_APP_API_URL || 'http://localhost:8080';

export interface NodeStats {
  function: string;
  total_calls: number;
  error_count: number;
  avg_latency_ms: number;
  is_entry_point: boolean;
  external_calls?: string[];
}

export interface EdgeStats {
  from: string;
  to: string;
  count: number;
}

export interface ExecutionMapResponse {
  service_name: string;
  total_requests: number;
  nodes: NodeStats[];
  edges: EdgeStats[];
}

export interface TelemetryLog {
  request_id: string;
  timestamp: string;
  service_name: string;
  process_type: string;
  endpoint: string;
  method_failure: boolean;
  process_failure: boolean;
  process_latency: number;
  execution_map: {
    index: number;
    current_function: string;
    parent_function: string;
    latency_ms: number;
    have_error: boolean;
    external_calls: { url: string }[];
  }[];
}

export interface ServiceLog {
  request_id: string;
  service_name: string;
  process_type: string;
  endpoint: string;
  timestamp: string;
  is_successful: boolean;
  latency_ms: number;
  execution_flow: {
    index: number;
    current_function: string;
    parent_function: string;
    input: string;
    output: string;
    latency_ms: number;
    have_error: boolean;
    logs: { timestamp: string; level: string; message: string }[];
    external_calls: { url: string }[];
  }[];
}

export async function fetchHealth(): Promise<{ status: string }> {
  const res = await fetch(`${API_BASE}/api/health`);
  return res.json();
}

export async function fetchServices(): Promise<string[]> {
  const res = await fetch(`${API_BASE}/api/services`);
  return res.json();
}

export async function fetchExecutionMap(
  serviceName: string,
  from?: string,
  to?: string
): Promise<ExecutionMapResponse> {
  const params = new URLSearchParams({ service_name: serviceName });
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  const res = await fetch(`${API_BASE}/api/execution-map?${params}`);
  return res.json();
}

export async function fetchTelemetryLogs(
  serviceName?: string,
  from?: string,
  to?: string
): Promise<TelemetryLog[]> {
  const params = new URLSearchParams();
  if (serviceName) params.set('service_name', serviceName);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  const res = await fetch(`${API_BASE}/api/telemetry-logs?${params}`);
  return res.json();
}

export async function fetchServiceLog(requestId: string): Promise<ServiceLog> {
  const res = await fetch(`${API_BASE}/api/service-logs/${requestId}`);
  return res.json();
}
