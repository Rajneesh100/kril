import React, { useState, useEffect, useCallback } from 'react';
import './App.css';
import ServiceGraph from './components/ServiceGraph';
import DetailPanel from './components/DetailPanel';
import {
  fetchServices,
  fetchExecutionMap,
  fetchTelemetryLogs,
  ExecutionMapResponse,
  NodeStats,
  TelemetryLog,
} from './api';

function App() {
  const [services, setServices] = useState<string[]>([]);
  const [selectedService, setSelectedService] = useState('');
  const [executionMap, setExecutionMap] = useState<ExecutionMapResponse | null>(null);
  const [telemetryLogs, setTelemetryLogs] = useState<TelemetryLog[]>([]);
  const [selectedFunction, setSelectedFunction] = useState<string | null>(null);
  const [selectedNodeStats, setSelectedNodeStats] = useState<NodeStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [connected, setConnected] = useState(false);
  const [errorThreshold, setErrorThreshold] = useState(10);

  // Time range: default to last 1 hour
  const [timeRange, setTimeRange] = useState('1h');

  const getTimeFrom = useCallback(() => {
    const now = new Date();
    const durations: Record<string, number> = {
      '15m': 15 * 60 * 1000,
      '1h': 60 * 60 * 1000,
      '6h': 6 * 60 * 60 * 1000,
      '24h': 24 * 60 * 60 * 1000,
      '7d': 7 * 24 * 60 * 60 * 1000,
    };
    return new Date(now.getTime() - (durations[timeRange] || durations['1h'])).toISOString();
  }, [timeRange]);

  // Check health + fetch services
  useEffect(() => {
    const init = async () => {
      try {
        const svc = await fetchServices();
        setServices(Array.isArray(svc) ? svc : []);
        setConnected(true);
      } catch {
        setConnected(false);
      }
    };
    init();
    const interval = setInterval(init, 30000);
    return () => clearInterval(interval);
  }, []);

  // Fetch data when service or time range changes
  useEffect(() => {
    if (!selectedService) {
      setExecutionMap(null);
      setTelemetryLogs([]);
      return;
    }

    const load = async () => {
      setLoading(true);
      try {
        const from = getTimeFrom();
        const [map, logs] = await Promise.all([
          fetchExecutionMap(selectedService, from),
          fetchTelemetryLogs(selectedService, from),
        ]);
        setExecutionMap(map);
        setTelemetryLogs(Array.isArray(logs) ? logs : []);
      } catch (err) {
        console.error('Failed to fetch data:', err);
      } finally {
        setLoading(false);
      }
    };

    load();
    const interval = setInterval(load, 10000); // Auto-refresh every 10s
    return () => clearInterval(interval);
  }, [selectedService, timeRange, getTimeFrom]);

  const handleNodeClick = useCallback((functionName: string) => {
    setSelectedFunction(functionName);
    if (executionMap?.nodes) {
      const node = executionMap.nodes.find(n => n.function === functionName);
      setSelectedNodeStats(node || null);
    }
  }, [executionMap]);

  const handleClosePanel = useCallback(() => {
    setSelectedFunction(null);
    setSelectedNodeStats(null);
  }, []);

  const handleRequestClick = useCallback((requestId: string) => {
    // TODO: open full request detail view
    console.log('View request:', requestId);
  }, []);

  return (
    <div className="app">
      <div className="topbar">
        <div className="topbar-brand">
          <span className="logo">&#x2B50;</span>
          <h1>starfish</h1>
        </div>
        <div className="topbar-controls">
          <div className={`status-dot ${connected ? '' : 'error'}`} title={connected ? 'Connected' : 'Disconnected'} />

          <select
            value={selectedService}
            onChange={(e) => {
              setSelectedService(e.target.value);
              handleClosePanel();
            }}
          >
            <option value="">Select service...</option>
            {services.map(s => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>

          <select value={timeRange} onChange={(e) => setTimeRange(e.target.value)}>
            <option value="15m">Last 15m</option>
            <option value="1h">Last 1h</option>
            <option value="6h">Last 6h</option>
            <option value="24h">Last 24h</option>
            <option value="7d">Last 7d</option>
          </select>

          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)' }}>
            Error %
            <input
              type="number"
              min={1}
              max={100}
              value={errorThreshold}
              onChange={(e) => setErrorThreshold(Number(e.target.value))}
              style={{ width: 50 }}
            />
          </label>

          {loading && <div className="spinner" />}
        </div>
      </div>

      <div className="main-content">
        <div className="graph-canvas">
          <ServiceGraph
            data={executionMap}
            onNodeClick={handleNodeClick}
            errorThresholdPct={errorThreshold}
          />
        </div>

        <DetailPanel
          selectedFunction={selectedFunction}
          nodeStats={selectedNodeStats}
          recentRequests={telemetryLogs}
          onClose={handleClosePanel}
          onRequestClick={handleRequestClick}
        />
      </div>
    </div>
  );
}

export default App;
