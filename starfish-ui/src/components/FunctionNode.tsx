import React, { memo } from 'react';
import { Handle, Position, NodeProps } from 'reactflow';

interface FunctionNodeData {
  label: string;
  totalCalls: number;
  errorCount: number;
  avgLatency: number;
  isEntryPoint: boolean;
  externalCalls: string[];
  errorThresholdPct: number;
}

function getErrorColor(errorPct: number, threshold: number): string {
  if (errorPct === 0) return 'transparent';
  // Scale from light red to dark red based on error percentage relative to threshold
  const intensity = Math.min(errorPct / Math.max(threshold, 1), 1);
  const alpha = 0.15 + intensity * 0.55; // 0.15 to 0.7
  return `rgba(239, 68, 68, ${alpha})`;
}

const FunctionNode: React.FC<NodeProps<FunctionNodeData>> = ({ data, selected }) => {
  const errorPct = data.totalCalls > 0 ? (data.errorCount / data.totalCalls) * 100 : 0;
  const hasError = data.errorCount > 0;
  const errorBg = getErrorColor(errorPct, data.errorThresholdPct || 10);
  const size = data.isEntryPoint ? 80 : 48;

  return (
    <div
      className={`fn-node ${data.isEntryPoint ? 'entry' : 'normal'} ${hasError ? 'has-error' : ''}`}
      style={{
        width: size,
        height: size,
        background: hasError ? errorBg : undefined,
        borderColor: selected ? 'var(--accent)' : hasError ? `rgba(239, 68, 68, ${0.4 + Math.min(errorPct / 100, 0.6)})` : undefined,
        boxShadow: selected ? '0 0 20px var(--accent-glow)' : hasError ? `0 0 12px rgba(239, 68, 68, ${0.2 + Math.min(errorPct / 200, 0.3)})` : undefined,
      }}
    >
      <Handle type="target" position={Position.Top} style={{ background: 'var(--border-glass-active)', border: 'none', width: 6, height: 6 }} />
      <div className="fn-node-stats">
        {data.isEntryPoint ? (
          <>
            <div style={{ fontSize: 13, fontWeight: 600 }}>{data.totalCalls}</div>
            <div style={{ fontSize: 9, color: 'var(--text-muted)' }}>calls</div>
          </>
        ) : (
          <div style={{ fontSize: 11 }}>{data.totalCalls}</div>
        )}
      </div>
      <div className="fn-node-label">{data.label}</div>
      <Handle type="source" position={Position.Bottom} style={{ background: 'var(--border-glass-active)', border: 'none', width: 6, height: 6 }} />
    </div>
  );
};

export default memo(FunctionNode);
