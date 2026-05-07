import React, { memo } from 'react';
import { Handle, Position, NodeProps } from 'reactflow';

/**
 * Grafana-style node graph node.
 * - Circle with arc border showing success/error ratio
 * - Two stats inside: call count + latency
 * - Label below
 * - Small badges for external calls (D=database, E=external API)
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
  const size = data.isEntryPoint ? 68 : 44;
  const r = size / 2;
  const strokeW = data.isEntryPoint ? 3.5 : 2.5;
  const innerR = r - strokeW / 2;

  const errorPct = data.totalCalls > 0 ? data.errorCount / data.totalCalls : 0;
  const successPct = 1 - errorPct;
  const hasError = data.errorCount > 0;

  // Arc calculation for SVG
  const circumference = 2 * Math.PI * innerR;
  const successLen = circumference * successPct;
  const errorLen = circumference * errorPct;

  // Colors
  const successColor = data.serviceColor || '#6e9fff';
  const errorColor = '#ff5286';
  const bgColor = hasError
    ? `rgba(209, 14, 92, ${0.06 + errorPct * 0.15})`
    : '#22252b';

  const hasDb = data.externalCalls?.some(ec =>
    ec.toLowerCase() === 'database' || ec.toLowerCase().includes('db')
  );
  const hasExt = data.externalCalls?.some(ec =>
    ec.toLowerCase() !== 'database' && !ec.toLowerCase().includes('db')
  );

  return (
    <div style={{
      position: 'relative',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      width: size + 30,
    }}>
      <Handle
        type="target"
        position={Position.Top}
        style={{ background: 'transparent', border: 'none', width: 1, height: 1, top: r }}
      />

      {/* SVG circle with arc border */}
      <div style={{
        position: 'relative',
        width: size,
        height: size,
        cursor: 'pointer',
        filter: selected ? 'brightness(1.2)' : undefined,
      }}>
        <svg width={size} height={size} style={{ position: 'absolute', top: 0, left: 0 }}>
          {/* Background circle */}
          <circle cx={r} cy={r} r={innerR} fill={bgColor} />
          {/* Success arc */}
          <circle
            cx={r} cy={r} r={innerR}
            fill="none"
            stroke={successColor}
            strokeWidth={strokeW}
            strokeDasharray={`${successLen} ${circumference}`}
            strokeDashoffset={circumference * 0.25}
            strokeLinecap="round"
            style={{ transition: 'stroke-dasharray 0.5s' }}
          />
          {/* Error arc */}
          {hasError && (
            <circle
              cx={r} cy={r} r={innerR}
              fill="none"
              stroke={errorColor}
              strokeWidth={strokeW}
              strokeDasharray={`${errorLen} ${circumference}`}
              strokeDashoffset={circumference * 0.25 - successLen}
              strokeLinecap="round"
              style={{ transition: 'stroke-dasharray 0.5s' }}
            />
          )}
          {/* Selection ring */}
          {selected && (
            <circle cx={r} cy={r} r={innerR + strokeW} fill="none" stroke="#fff" strokeWidth={1} opacity={0.3} />
          )}
        </svg>

        {/* Stats inside */}
        <div style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: size,
          height: size,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 0,
        }}>
          <div style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: data.isEntryPoint ? 15 : 11,
            fontWeight: 600,
            color: '#d8dade',
            lineHeight: 1.1,
          }}>
            {data.totalCalls}
          </div>
          {data.isEntryPoint && (
            <div style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 9,
              color: '#585e67',
              lineHeight: 1.1,
              marginTop: 1,
            }}>
              {data.avgLatency < 1 ? '<1ms' : `${data.avgLatency.toFixed(0)}ms`}
            </div>
          )}
        </div>
      </div>

      {/* Badges */}
      {(hasDb || hasExt) && (
        <div style={{
          position: 'absolute',
          top: -1,
          right: data.isEntryPoint ? 8 : 6,
          display: 'flex',
          gap: 1,
        }}>
          {hasDb && (
            <div style={{
              width: 13, height: 13, borderRadius: 2,
              background: '#22252b',
              border: '1px solid #383b42',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 7, fontWeight: 700, color: '#6e9fff',
              fontFamily: "'JetBrains Mono', monospace",
            }}>D</div>
          )}
          {hasExt && (
            <div style={{
              width: 13, height: 13, borderRadius: 2,
              background: '#22252b',
              border: '1px solid #383b42',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 7, fontWeight: 700, color: '#fbad37',
              fontFamily: "'JetBrains Mono', monospace",
            }}>E</div>
          )}
        </div>
      )}

      {/* Error count badge */}
      {hasError && (
        <div style={{
          position: 'absolute',
          bottom: data.isEntryPoint ? 18 : 12,
          left: data.isEntryPoint ? 6 : 2,
          background: '#d10e5c',
          color: '#fff',
          fontSize: 8,
          fontWeight: 700,
          fontFamily: "'JetBrains Mono', monospace",
          padding: '1px 3px',
          borderRadius: 3,
          lineHeight: 1.2,
        }}>
          {data.errorCount}
        </div>
      )}

      {/* Label */}
      <div style={{
        marginTop: 4,
        fontSize: 10,
        fontFamily: "'JetBrains Mono', monospace",
        color: '#8e939c',
        textAlign: 'center',
        maxWidth: size + 30,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        lineHeight: 1.2,
      }}>
        {data.label}
      </div>

      {/* Latency for non-entry nodes */}
      {!data.isEntryPoint && (
        <div style={{
          fontSize: 9,
          fontFamily: "'JetBrains Mono', monospace",
          color: '#585e67',
          lineHeight: 1,
        }}>
          {data.avgLatency < 1 ? '<1' : data.avgLatency.toFixed(0)}ms
        </div>
      )}

      <Handle
        type="source"
        position={Position.Bottom}
        style={{ background: 'transparent', border: 'none', width: 1, height: 1, bottom: -14 }}
      />
    </div>
  );
};

export default memo(FunctionNode);
