import React, { useState, useEffect, useCallback, useRef } from 'react';
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
  const [selectedServices, setSelectedServices] = useState<string[]>([]);
  const [datasets, setDatasets] = useState<{ service: string; data: ExecutionMapResponse }[]>([]);
  const [telemetryLogs, setTelemetryLogs] = useState<TelemetryLog[]>([]);
  const [selectedFunction, setSelectedFunction] = useState<string | null>(null);
  const [selectedService, setSelectedService] = useState<string | null>(null);
  const [selectedNodeStats, setSelectedNodeStats] = useState<NodeStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [connected, setConnected] = useState(false);
  const [errorThreshold, setErrorThreshold] = useState(10);
  const [timeRange, setTimeRange] = useState('1h');
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

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

  // Fetch services
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

  // Fetch data for all selected services
  useEffect(() => {
    if (selectedServices.length === 0) {
      setDatasets([]);
      setTelemetryLogs([]);
      return;
    }

    const load = async () => {
      setLoading(true);
      try {
        const from = getTimeFrom();
        const results = await Promise.all(
          selectedServices.map(async (svc) => {
            const [map, logs] = await Promise.all([
              fetchExecutionMap(svc, from),
              fetchTelemetryLogs(svc, from),
            ]);
            return { service: svc, map, logs: Array.isArray(logs) ? logs : [] };
          })
        );

        setDatasets(results.map(r => ({ service: r.service, data: r.map })));
        setTelemetryLogs(results.flatMap(r => r.logs));
      } catch (err) {
        console.error('Failed to fetch data:', err);
      } finally {
        setLoading(false);
      }
    };

    load();
    const interval = setInterval(load, 10000);
    return () => clearInterval(interval);
  }, [selectedServices, timeRange, getTimeFrom]);

  // Close dropdown on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as HTMLElement)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const toggleService = useCallback((svc: string) => {
    setSelectedServices(prev =>
      prev.includes(svc) ? prev.filter(s => s !== svc) : [...prev, svc]
    );
  }, []);

  const selectAll = useCallback(() => {
    setSelectedServices(services);
  }, [services]);

  const handleNodeClick = useCallback((functionName: string, serviceName: string) => {
    setSelectedFunction(functionName);
    setSelectedService(serviceName);
    const ds = datasets.find(d => d.service === serviceName);
    if (ds?.data?.nodes) {
      const node = ds.data.nodes.find(n => n.function === functionName);
      setSelectedNodeStats(node || null);
    }
  }, [datasets]);

  const handleClosePanel = useCallback(() => {
    setSelectedFunction(null);
    setSelectedService(null);
    setSelectedNodeStats(null);
  }, []);

  const handleRequestClick = useCallback((requestId: string) => {
    console.log('View request:', requestId);
  }, []);

  return (
    <div className="app">
      <div className="topbar">
        <div className="topbar-brand">
          <span className="logo">🦞</span>
          <h1>Kril</h1>
        </div>
        <div className="topbar-controls">
          <div className={`status-dot ${connected ? '' : 'error'}`} title={connected ? 'Connected' : 'Disconnected'} />

          {/* Multi-select dropdown */}
          <div className="multi-select" ref={dropdownRef}>
            <button
              className="multi-select-trigger"
              onClick={() => setDropdownOpen(!dropdownOpen)}
            >
              {selectedServices.length === 0
                ? 'Select services...'
                : selectedServices.length === services.length
                ? `All services (${services.length})`
                : selectedServices.join(', ')}
              <span className="chevron">{dropdownOpen ? '\u25B2' : '\u25BC'}</span>
            </button>
            {dropdownOpen && (
              <div className="multi-select-dropdown">
                <button className="multi-select-all" onClick={selectAll}>
                  Select all
                </button>
                {selectedServices.length > 0 && (
                  <button className="multi-select-all" onClick={() => setSelectedServices([])}>
                    Clear all
                  </button>
                )}
                <div className="multi-select-divider" />
                {services.map(svc => (
                  <label key={svc} className="multi-select-option">
                    <input
                      type="checkbox"
                      checked={selectedServices.includes(svc)}
                      onChange={() => toggleService(svc)}
                    />
                    <span className="svc-name">{svc}</span>
                  </label>
                ))}
                {services.length === 0 && (
                  <div className="multi-select-empty">No services found</div>
                )}
              </div>
            )}
          </div>

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
            datasets={datasets}
            onNodeClick={handleNodeClick}
            errorThresholdPct={errorThreshold}
          />
          {/* Grafana-style legend */}
          <div className="graph-legend">
            <span className="legend-item"><span className="legend-dot" style={{ background: '#73BF69' }} /> Success</span>
            <span className="legend-item"><span className="legend-dot" style={{ background: '#F2495C' }} /> Errors</span>
            <span className="legend-item"><span className="legend-line" /> Internal call</span>
            <span className="legend-item"><span className="legend-line dashed orange" /> Cross-service</span>
            <span className="legend-item"><span className="legend-line dashed" /> Database</span>
          </div>
        </div>

        <DetailPanel
          selectedFunction={selectedFunction}
          selectedService={selectedService}
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
