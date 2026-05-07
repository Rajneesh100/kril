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
  serviceName?: string;
  serviceColor?: string;
}

function getErrorIntensity(errorPct: number, threshold: number): number {
  if (errorPct === 0) return 0;
  return Math.min(errorPct / Math.max(threshold, 1), 1);
}

const FunctionNode: React.FC<NodeProps<FunctionNodeData>> = ({ data, selected }) => {
  const errorPct = data.totalCalls > 0 ? (data.errorCount / data.totalCalls) * 100 : 0;
  const hasError = data.errorCount > 0;
  const intensity = getErrorIntensity(errorPct, data.errorThresholdPct || 10);
  const size = data.isEntryPoint ? 72 : 46;

  // Badges: count external call types
  const hasDb = data.externalCalls?.some(ec => ec.toLowerCase() === 'database' || ec.toLowerCase().includes('db'));
  const hasExt = data.externalCalls?.some(ec => ec.toLowerCase() !== 'database' && !ec.toLowerCase().includes('db'));

  // Colors
  const borderColor = selected
    ? '#fff'
    : hasError
    ? `rgba(239, 68, 68, ${0.5 + intensity * 0.5})`
    : data.serviceColor || 'rgba(255,255,255,0.15)';

  const bgColor = hasError
    ? `rgba(239, 68, 68, ${0.08 + intensity * 0.2})`
    : 'rgba(255, 255, 255, 0.04)';

  const glowColor = selected
    ? '0 0 20px rgba(255,255,255,0.15)'
    : hasError
    ? `0 0 ${8 + intensity * 16}px rgba(239, 68, 68, ${0.15 + intensity * 0.25})`
    : 'none';

  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <Handle
        type="target"
        position={Position.Top}
        style={{ background: 'transparent', border: 'none', width: 1, height: 1, top: size / 2 }}
      />

      {/* Main circle */}
      <div
        style={{
          width: size,
          height: size,
          borderRadius: '50%',
          background: bgColor,
          border: `2px solid ${borderColor}`,
          boxShadow: glowColor,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          transition: 'box-shadow 0.3s, border-color 0.3s',
          backdropFilter: 'blur(6px)',
        }}
      >
        {/* Call count */}
        <div style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: data.isEntryPoint ? 16 : 12,
          fontWeight: 600,
          color: hasError ? `rgba(239, 68, 68, ${0.7 + intensity * 0.3})` : '#e4e4e7',
          lineHeight: 1,
        }}>
          {data.totalCalls}
        </div>
        {data.isEntryPoint && (
          <div style={{
            fontSize: 9,
            color: 'rgba(255,255,255,0.4)',
            marginTop: 2,
            letterSpacing: '0.04em',
          }}>
            calls
          </div>
        )}
      </div>

      {/* Badges for external calls */}
      {(hasDb || hasExt) && (
        <div style={{
          position: 'absolute',
          top: -2,
          right: data.isEntryPoint ? 0 : -4,
          display: 'flex',
          gap: 2,
        }}>
          {hasDb && (
            <div style={{
              width: 14, height: 14, borderRadius: 3,
              background: 'rgba(99, 102, 241, 0.25)',
              border: '1px solid rgba(99, 102, 241, 0.4)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 8,
            }}>
              D
            </div>
          )}
          {hasExt && (
            <div style={{
              width: 14, height: 14, borderRadius: 3,
              background: 'rgba(250, 204, 21, 0.2)',
              border: '1px solid rgba(250, 204, 21, 0.4)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 8,
            }}>
              E
            </div>
          )}
        </div>
      )}

      {/* Error count badge */}
      {hasError && (
        <div style={{
          position: 'absolute',
          bottom: data.isEntryPoint ? 12 : 6,
          left: data.isEntryPoint ? -2 : -6,
          background: 'rgba(239, 68, 68, 0.9)',
          color: '#fff',
          fontSize: 9,
          fontWeight: 700,
          fontFamily: "'JetBrains Mono', monospace",
          padding: '1px 4px',
          borderRadius: 4,
          lineHeight: 1.3,
        }}>
          {data.errorCount}
        </div>
      )}

      {/* Label below */}
      <div style={{
        marginTop: 5,
        fontSize: 10,
        fontFamily: "'JetBrains Mono', monospace",
        color: 'rgba(255,255,255,0.5)',
        textAlign: 'center',
        maxWidth: data.isEntryPoint ? 100 : 85,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        lineHeight: 1.2,
      }}>
        {data.label}
      </div>

      {/* Latency */}
      <div style={{
        fontSize: 9,
        fontFamily: "'JetBrains Mono', monospace",
        color: 'rgba(255,255,255,0.3)',
        lineHeight: 1,
      }}>
        {data.avgLatency < 1 ? '<1' : data.avgLatency.toFixed(0)}ms
      </div>

      <Handle
        type="source"
        position={Position.Bottom}
        style={{ background: 'transparent', border: 'none', width: 1, height: 1, bottom: -14 }}
      />
    </div>
  );
};

export default memo(FunctionNode);
