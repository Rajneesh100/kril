import React, { useCallback, useMemo, useEffect } from 'react';
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  Node,
  Edge,
  useNodesState,
  useEdgesState,
  MarkerType,
  ConnectionLineType,
} from 'reactflow';
import 'reactflow/dist/style.css';
import FunctionNode from './FunctionNode';
import ExternalNode from './ExternalNode';
import { ExecutionMapResponse, NodeStats } from '../api';

const nodeTypes = {
  functionNode: FunctionNode,
  externalNode: ExternalNode,
};

interface ServiceGraphProps {
  datasets: { service: string; data: ExecutionMapResponse }[];
  onNodeClick: (functionName: string, serviceName: string) => void;
  errorThresholdPct: number;
}

const SERVICE_COLORS = [
  { border: 'rgba(99, 102, 241, 0.45)', bg: 'rgba(99, 102, 241, 0.03)', label: '#6366f1', edge: 'rgba(99, 102, 241, 0.35)' },
  { border: 'rgba(34, 197, 94, 0.45)', bg: 'rgba(34, 197, 94, 0.03)', label: '#22c55e', edge: 'rgba(34, 197, 94, 0.35)' },
  { border: 'rgba(249, 115, 22, 0.45)', bg: 'rgba(249, 115, 22, 0.03)', label: '#f97316', edge: 'rgba(249, 115, 22, 0.35)' },
  { border: 'rgba(236, 72, 153, 0.45)', bg: 'rgba(236, 72, 153, 0.03)', label: '#ec4899', edge: 'rgba(236, 72, 153, 0.35)' },
  { border: 'rgba(14, 165, 233, 0.45)', bg: 'rgba(14, 165, 233, 0.03)', label: '#0ea5e9', edge: 'rgba(14, 165, 233, 0.35)' },
];

/**
 * Radial layout inside a circular bubble.
 * - Entry-point nodes sit in the inner ring (closer to center)
 * - Other nodes in the outer ring
 * - Positions are deterministic: sorted by function name
 */
function layoutMultiService(
  datasets: { service: string; data: ExecutionMapResponse }[]
): { nodes: Node[]; edges: Edge[] } {
  if (datasets.length === 0) return { nodes: [], edges: [] };

  const rfNodes: Node[] = [];
  const rfEdges: Edge[] = [];

  // Gap between service bubbles
  const BUBBLE_RADIUS = 260;
  const BUBBLE_GAP = 680;

  datasets.forEach(({ service, data }, svcIdx) => {
    if (!data || !data.nodes || data.nodes.length === 0) return;

    const color = SERVICE_COLORS[svcIdx % SERVICE_COLORS.length];
    const centerX = svcIdx * BUBBLE_GAP;
    const centerY = 0;

    // Sort nodes deterministically by name for stable positions
    const sortedNodes = [...data.nodes].sort((a, b) => a.function.localeCompare(b.function));
    const entryNodes = sortedNodes.filter(n => n.is_entry_point);
    const innerNodes = sortedNodes.filter(n => !n.is_entry_point);

    // Circular bubble background
    const bubbleSize = BUBBLE_RADIUS * 2;
    rfNodes.push({
      id: `bubble-${service}`,
      type: 'group',
      position: { x: centerX - BUBBLE_RADIUS, y: centerY - BUBBLE_RADIUS },
      style: {
        width: bubbleSize,
        height: bubbleSize,
        borderRadius: '50%',
        background: color.bg,
        border: `2px dashed ${color.border}`,
        zIndex: -1,
        pointerEvents: 'none' as const,
      },
      data: { label: '' },
      selectable: false,
      draggable: false,
    });

    // Service label above bubble
    rfNodes.push({
      id: `label-${service}`,
      type: 'default',
      position: { x: centerX - 60, y: centerY - BUBBLE_RADIUS - 35 },
      style: {
        background: 'transparent',
        border: 'none',
        color: color.label,
        fontSize: '13px',
        fontWeight: 700,
        letterSpacing: '0.06em',
        textTransform: 'uppercase' as const,
        width: 120,
        textAlign: 'center' as const,
        pointerEvents: 'none' as const,
      },
      data: { label: service },
      selectable: false,
      draggable: false,
    });

    // Place entry nodes in inner ring
    const INNER_RADIUS = entryNodes.length <= 1 ? 0 : 70;
    entryNodes.forEach((nodeData, i) => {
      const angle = entryNodes.length <= 1
        ? 0
        : (2 * Math.PI * i) / entryNodes.length - Math.PI / 2;
      const x = centerX + INNER_RADIUS * Math.cos(angle);
      const y = centerY + INNER_RADIUS * Math.sin(angle);

      rfNodes.push({
        id: `${service}::${nodeData.function}`,
        type: 'functionNode',
        position: { x: x - 40, y: y - 40 }, // offset for node center
        data: {
          label: nodeData.function,
          totalCalls: nodeData.total_calls,
          errorCount: nodeData.error_count,
          avgLatency: nodeData.avg_latency_ms,
          isEntryPoint: true,
          externalCalls: nodeData.external_calls || [],
          errorThresholdPct: 10,
          serviceName: service,
          serviceColor: color.label,
        },
      });
    });

    // Place other nodes in outer ring
    const OUTER_RADIUS = 170;
    innerNodes.forEach((nodeData, i) => {
      const angle = (2 * Math.PI * i) / Math.max(innerNodes.length, 1) - Math.PI / 2;
      const x = centerX + OUTER_RADIUS * Math.cos(angle);
      const y = centerY + OUTER_RADIUS * Math.sin(angle);

      rfNodes.push({
        id: `${service}::${nodeData.function}`,
        type: 'functionNode',
        position: { x: x - 24, y: y - 24 }, // offset for node center
        data: {
          label: nodeData.function,
          totalCalls: nodeData.total_calls,
          errorCount: nodeData.error_count,
          avgLatency: nodeData.avg_latency_ms,
          isEntryPoint: false,
          externalCalls: nodeData.external_calls || [],
          errorThresholdPct: 10,
          serviceName: service,
          serviceColor: color.label,
        },
      });
    });

    // Collect external calls for perimeter nodes
    const allExternals = new Set<string>();
    const extSources: Record<string, string[]> = {};
    for (const node of data.nodes) {
      for (const ec of (node.external_calls || [])) {
        allExternals.add(ec);
        if (!extSources[ec]) extSources[ec] = [];
        extSources[ec].push(`${service}::${node.function}`);
      }
    }

    // Place external nodes just outside the bubble perimeter
    const extList = Array.from(allExternals).sort();
    const EXT_RADIUS = BUBBLE_RADIUS + 50;
    extList.forEach((ec, i) => {
      const angle = (2 * Math.PI * i) / Math.max(extList.length, 1) + Math.PI; // start from bottom
      const x = centerX + EXT_RADIUS * Math.cos(angle);
      const y = centerY + EXT_RADIUS * Math.sin(angle);

      const isDb = ec.toLowerCase() === 'database' || ec.toLowerCase().includes('db');
      const extId = `${service}::ext-${ec}`;
      rfNodes.push({
        id: extId,
        type: 'externalNode',
        position: { x: x - 18, y: y - 18 },
        data: {
          label: isDb ? 'database' : ec.length > 20 ? ec.substring(0, 20) + '...' : ec,
          isDatabase: isDb,
        },
      });

      for (const source of (extSources[ec] || [])) {
        rfEdges.push({
          id: `${source}->ext-${ec}`,
          source,
          target: extId,
          animated: true,
          type: 'straight',
          style: {
            strokeWidth: 1,
            stroke: 'rgba(161, 161, 170, 0.25)',
            strokeDasharray: '4 4',
          },
        });
      }
    });

    // Intra-service edges (function -> function)
    const maxEdgeCount = Math.max(1, ...(data.edges || []).map(e => e.count));
    for (const edge of (data.edges || [])) {
      const thickness = 1.5 + (edge.count / maxEdgeCount) * 4;
      rfEdges.push({
        id: `${service}::${edge.from}->${edge.to}`,
        source: `${service}::${edge.from}`,
        target: `${service}::${edge.to}`,
        type: 'straight',
        style: {
          strokeWidth: thickness,
          stroke: color.edge,
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: color.edge,
          width: 10,
          height: 10,
        },
      });
    }
  });

  // Inter-service edges (when multiple services selected)
  if (datasets.length > 1) {
    // Map from service name to its entry-point node IDs
    const serviceEntries: Record<string, string[]> = {};
    for (const { service, data } of datasets) {
      if (!data?.nodes) continue;
      serviceEntries[service] = data.nodes
        .filter(n => n.is_entry_point)
        .map(n => `${service}::${n.function}`);
    }

    // Find nodes that call other services
    for (const { service, data } of datasets) {
      if (!data?.nodes) continue;
      for (const node of data.nodes) {
        for (const ec of (node.external_calls || [])) {
          if (ec === 'database') continue;
          // Try to match this external call to another selected service
          for (const other of datasets) {
            if (other.service === service) continue;
            if (ec.includes('808') && serviceEntries[other.service]?.length) {
              const sourceId = `${service}::${node.function}`;
              const targetId = serviceEntries[other.service][0];
              rfEdges.push({
                id: `inter-${sourceId}->${targetId}`,
                source: sourceId,
                target: targetId,
                type: 'straight',
                animated: true,
                style: {
                  strokeWidth: 2,
                  stroke: 'rgba(250, 204, 21, 0.4)',
                },
                markerEnd: {
                  type: MarkerType.ArrowClosed,
                  color: 'rgba(250, 204, 21, 0.4)',
                  width: 12,
                  height: 12,
                },
              });
            }
          }
        }
      }
    }
  }

  return { nodes: rfNodes, edges: rfEdges };
}

const ServiceGraph: React.FC<ServiceGraphProps> = ({ datasets, onNodeClick, errorThresholdPct }) => {
  const { nodes: layoutedNodes, edges: layoutedEdges } = useMemo(
    () => layoutMultiService(datasets),
    [datasets]
  );

  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);

  // Only update data (colors/counts) without changing positions
  useEffect(() => {
    setNodes(prev => {
      if (prev.length === 0 || prev.length !== layoutedNodes.length) {
        // First load or structure changed — set all positions
        return layoutedNodes.map(n => ({
          ...n,
          data: n.type === 'functionNode' ? { ...n.data, errorThresholdPct } : n.data,
        }));
      }
      // Structure same — only update data, keep existing positions
      const prevMap = new Map(prev.map(n => [n.id, n]));
      return layoutedNodes.map(n => {
        const existing = prevMap.get(n.id);
        return {
          ...n,
          position: existing ? existing.position : n.position,
          data: n.type === 'functionNode' ? { ...n.data, errorThresholdPct } : n.data,
        };
      });
    });
    setEdges(layoutedEdges);
  }, [layoutedNodes, layoutedEdges, errorThresholdPct, setNodes, setEdges]);

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      if (node.id.startsWith('bubble-') || node.id.startsWith('label-') || node.id.includes('ext-')) return;
      const [service, fn] = node.id.split('::');
      if (service && fn) onNodeClick(fn, service);
    },
    [onNodeClick]
  );

  if (datasets.length === 0 || datasets.every(d => !d.data?.nodes?.length)) {
    return (
      <div className="empty-state">
        <div className="icon">&#x2B50;</div>
        <p>Select one or more services to view the execution map</p>
      </div>
    );
  }

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeClick={handleNodeClick}
      nodeTypes={nodeTypes}
      fitView
      fitViewOptions={{ padding: 0.4 }}
      minZoom={0.1}
      maxZoom={2.5}
      connectionLineType={ConnectionLineType.Straight}
      defaultEdgeOptions={{ type: 'straight' }}
    >
      <Background color="rgba(255,255,255,0.03)" gap={24} />
      <Controls />
      <MiniMap
        nodeColor={(n) => {
          if (n.type === 'externalNode') return '#71717a';
          if (n.id.startsWith('bubble-') || n.id.startsWith('label-')) return 'transparent';
          const d = n.data as any;
          if (d?.errorCount > 0) return '#ef4444';
          if (d?.serviceColor) return d.serviceColor;
          if (d?.isEntryPoint) return '#6366f1';
          return '#a1a1aa';
        }}
        maskColor="rgba(0,0,0,0.7)"
      />
    </ReactFlow>
  );
};

export default ServiceGraph;
