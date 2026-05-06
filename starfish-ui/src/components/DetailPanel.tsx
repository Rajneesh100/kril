import React from 'react';
import { NodeStats, TelemetryLog } from '../api';

interface DetailPanelProps {
  selectedFunction: string | null;
  nodeStats: NodeStats | null;
  recentRequests: TelemetryLog[];
  onClose: () => void;
  onRequestClick: (requestId: string) => void;
}

const DetailPanel: React.FC<DetailPanelProps> = ({
  selectedFunction,
  nodeStats,
  recentRequests,
  onClose,
  onRequestClick,
}) => {
  if (!selectedFunction || !nodeStats) {
    return (
      <div className="side-panel">
        <div className="panel-header">
          <h2>Details</h2>
        </div>
        <div className="panel-body">
          <div className="empty-state" style={{ height: '200px' }}>
            <p style={{ fontSize: 13 }}>Click a node to see details</p>
          </div>
        </div>
      </div>
    );
  }

  const errorPct = nodeStats.total_calls > 0
    ? ((nodeStats.error_count / nodeStats.total_calls) * 100).toFixed(1)
    : '0.0';

  // Filter requests that involve this function
  const relevant = recentRequests.filter(r =>
    r.execution_map?.some(em => em.current_function === selectedFunction)
  );

  return (
    <div className="side-panel">
      <div className="panel-header">
        <h2 style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>{selectedFunction}</h2>
        <button className="panel-close" onClick={onClose}>&times;</button>
      </div>
      <div className="panel-body">
        <div className="stats-grid">
          <div className="stat-card">
            <div className="stat-label">Total Calls</div>
            <div className="stat-value">{nodeStats.total_calls.toLocaleString()}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Error Rate</div>
            <div className={`stat-value ${parseFloat(errorPct) > 0 ? 'error' : 'success'}`}>
              {errorPct}%
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Avg Latency</div>
            <div className="stat-value">{nodeStats.avg_latency_ms.toFixed(1)}ms</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Errors</div>
            <div className="stat-value error">{nodeStats.error_count}</div>
          </div>
        </div>

        {nodeStats.external_calls && nodeStats.external_calls.length > 0 && (
          <div className="log-section">
            <h3>External Calls</h3>
            {nodeStats.external_calls.map((ec, i) => (
              <div key={i} className="log-entry info">
                {ec.toLowerCase() === 'database' ? '🛢 ' : '🔗 '}
                {ec}
              </div>
            ))}
          </div>
        )}

        <div className="request-list">
          <div className="log-section">
            <h3>Recent Requests ({relevant.length})</h3>
          </div>
          {relevant.slice(0, 50).map(r => (
            <div
              key={r.request_id}
              className="request-item"
              onClick={() => onRequestClick(r.request_id)}
            >
              <span className={`method ${r.process_failure ? 'failed' : ''}`}>
                {r.process_type?.toUpperCase() || 'API'}
              </span>
              <span className="endpoint">{r.endpoint}</span>
              <span className="latency">{r.process_latency.toFixed(0)}ms</span>
            </div>
          ))}
          {relevant.length === 0 && (
            <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '8px 0' }}>
              No recent requests for this function
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default DetailPanel;
