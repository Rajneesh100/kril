import React, { memo } from 'react';
import { Handle, Position, NodeProps } from 'reactflow';

/**
 * Grafana node-graph style node.
 * - Clean circle with colored arc border (green=success, red=errors)
 * - Two stats inside: avg latency (ms/t) + call rate (calls)
 * - Label below the node
 * - Minimal, no heavy decorations
 */

interface FunctionNodeData {
  label: string;
  totalCalls: number;
  errorCount: number;
  avgLatency: number;
  isEntryPoint: boolean;
  externalCalls: string[];
  errorThresholdPct: number;
  serviceName?: string;
  serviceColor?: string;
}

const FunctionNode: React.FC<NodeProps<FunctionNodeData>> = ({ data, selected }) => {
  const size = data.isEntryPoint ? 72 : 52;
  const r = size / 2;
  const strokeW = 3;
  const innerR = r - strokeW / 2 - 1;

  const total = data.totalCalls || 1;
  const errorPct = data.errorCount / total;
  const successPct = 1 - errorPct;
  const hasError = data.errorCount > 0;

  // Grafana colors
  const green = '#73BF69';  // Grafana success green
  const red = '#F2495C';    // Grafana error red

  // Arc: success portion green, error portion red
  const circumference = 2 * Math.PI * innerR;
  const successLen = circumference * successPct;
  const errorLen = circumference * errorPct;

  // Determine border color when no error
  const healthyColor = data.serviceColor || green;

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      cursor: 'pointer',
    }}>
      <Handle
        type="target"
        position={Position.Top}
        style={{ background: 'transparent', border: 'none', width: 1, height: 1, top: r }}
      />

      <div style={{ position: 'relative', width: size, height: size }}>
        <svg width={size} height={size}>
          {/* Dark fill */}
          <circle cx={r} cy={r} r={innerR} fill="#1a1d24" />

          {/* Success arc (green) */}
          <circle
            cx={r} cy={r} r={innerR}
            fill="none"
            stroke={hasError ? green : healthyColor}
            strokeWidth={strokeW}
            strokeDasharray={`${successLen} ${circumference}`}
            strokeDashoffset={circumference * 0.25}
            opacity={0.85}
          />

          {/* Error arc (red) */}
          {hasError && (
            <circle
              cx={r} cy={r} r={innerR}
              fill="none"
              stroke={red}
              strokeWidth={strokeW}
              strokeDasharray={`${errorLen} ${circumference}`}
              strokeDashoffset={circumference * 0.25 - successLen}
              opacity={0.9}
            />
          )}

          {/* Selection highlight */}
          {selected && (
            <circle cx={r} cy={r} r={r - 1} fill="none" stroke="#fff" strokeWidth={1.5} opacity={0.4} />
          )}
        </svg>

        {/* Two stats inside — like Grafana: latency + count */}
        <div style={{
          position: 'absolute',
          top: 0, left: 0, width: size, height: size,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 1,
        }}>
          <div style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: data.isEntryPoint ? 12 : 10,
            fontWeight: 500,
            color: '#d8dade',
            lineHeight: 1.2,
          }}>
            {data.avgLatency < 1 ? '<1' : data.avgLatency.toFixed(1)}<span style={{ fontSize: '0.75em', color: '#8e939c' }}> ms</span>
          </div>
          <div style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: data.isEntryPoint ? 10 : 8.5,
            color: '#8e939c',
            lineHeight: 1.2,
          }}>
            {data.totalCalls}<span style={{ fontSize: '0.8em' }}> calls</span>
          </div>
        </div>
      </div>

      {/* Label below — Grafana style */}
      <div style={{
        marginTop: 6,
        fontSize: 11,
        fontFamily: "'Inter', sans-serif",
        color: '#d8dade',
        textAlign: 'center',
        maxWidth: 110,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        lineHeight: 1.2,
        fontWeight: 400,
      }}>
        {data.label}
      </div>

      <Handle
        type="source"
        position={Position.Bottom}
        style={{ background: 'transparent', border: 'none', width: 1, height: 1, bottom: -16 }}
      />
    </div>
  );
};

export default memo(FunctionNode);
