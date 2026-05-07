import React, { useCallback, useMemo, useEffect, useRef } from 'react';
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
import { ExecutionMapResponse, NodeStats } from '../api';

const nodeTypes = { functionNode: FunctionNode };

interface ServiceGraphProps {
  datasets: { service: string; data: ExecutionMapResponse }[];
  onNodeClick: (functionName: string, serviceName: string) => void;
  errorThresholdPct: number;
}

const SERVICE_COLORS = [
  { border: 'rgba(99, 102, 241, 0.35)', bg: 'rgba(99, 102, 241, 0.025)', label: '#818cf8', edge: 'rgba(99, 102, 241, 0.3)' },
  { border: 'rgba(52, 211, 153, 0.35)', bg: 'rgba(52, 211, 153, 0.025)', label: '#6ee7b7', edge: 'rgba(52, 211, 153, 0.3)' },
  { border: 'rgba(251, 146, 60, 0.35)', bg: 'rgba(251, 146, 60, 0.025)', label: '#fdba74', edge: 'rgba(251, 146, 60, 0.3)' },
  { border: 'rgba(244, 114, 182, 0.35)', bg: 'rgba(244, 114, 182, 0.025)', label: '#f9a8d4', edge: 'rgba(244, 114, 182, 0.3)' },
  { border: 'rgba(56, 189, 248, 0.35)', bg: 'rgba(56, 189, 248, 0.025)', label: '#7dd3fc', edge: 'rgba(56, 189, 248, 0.3)' },
];

/**
 * Hierarchical layout inside circular bubbles.
 * - BFS from entry points to assign depth levels
 * - Nodes placed top-to-bottom within the bubble
 * - Deterministic ordering (sorted by name) for stable positions
 * - External calls shown as badges on nodes, NOT as separate nodes
 * - Inter-service: single edge between bubble centers
 */
function layoutGraph(
  datasets: { service: string; data: ExecutionMapResponse }[]
): { nodes: Node[]; edges: Edge[] } {
  if (datasets.length === 0) return { nodes: [], edges: [] };

  const rfNodes: Node[] = [];
  const rfEdges: Edge[] = [];
  const BUBBLE_GAP = 620;
  const serviceCenters: Record<string, { x: number; y: number }> = {};

  // Track which services call which other services
  const interServiceEdges = new Set<string>();

  datasets.forEach(({ service, data }, svcIdx) => {
    if (!data?.nodes?.length) return;

    const color = SERVICE_COLORS[svcIdx % SERVICE_COLORS.length];
    const centerX = svcIdx * BUBBLE_GAP;
    const centerY = 0;
    serviceCenters[service] = { x: centerX, y: centerY };

    // Build adjacency for BFS
    const children: Record<string, string[]> = {};
    for (const edge of (data.edges || [])) {
      if (!children[edge.from]) children[edge.from] = [];
      children[edge.from].push(edge.to);
    }

    // Identify entry points
    const parentSet = new Set((data.edges || []).map(e => e.to));
    const entryPoints = data.nodes
      .filter(n => n.is_entry_point || !parentSet.has(n.function))
      .map(n => n.function)
      .sort();

    // BFS to assign levels
    const levels: Record<string, number> = {};
    const queue = [...entryPoints];
    for (const ep of entryPoints) levels[ep] = 0;
    while (queue.length > 0) {
      const fn = queue.shift()!;
      for (const child of (children[fn] || []).sort()) {
        if (levels[child] === undefined) {
          levels[child] = levels[fn] + 1;
          queue.push(child);
        }
      }
    }
    // Catch unvisited
    for (const n of data.nodes) {
      if (levels[n.function] === undefined) levels[n.function] = 0;
    }

    // Group by level, sort within each level for stability
    const levelGroups: Record<number, NodeStats[]> = {};
    for (const node of data.nodes) {
      const lvl = levels[node.function];
      if (!levelGroups[lvl]) levelGroups[lvl] = [];
      levelGroups[lvl].push(node);
    }
    for (const lvl of Object.keys(levelGroups)) {
      levelGroups[Number(lvl)].sort((a, b) => a.function.localeCompare(b.function));
    }

    const maxLevel = Math.max(0, ...Object.keys(levelGroups).map(Number));
    const totalLevels = maxLevel + 1;
    const maxNodesInLevel = Math.max(...Object.values(levelGroups).map(g => g.length));

    // Bubble sizing based on content
    const NODE_H_SPACING = 130;
    const NODE_V_SPACING = 110;
    const bubbleRadius = Math.max(180, Math.max(
      (maxNodesInLevel * NODE_H_SPACING) / 2 + 60,
      (totalLevels * NODE_V_SPACING) / 2 + 60,
    ));

    // Circular bubble
    rfNodes.push({
      id: `bubble-${service}`,
      type: 'group',
      position: { x: centerX - bubbleRadius, y: centerY - bubbleRadius },
      style: {
        width: bubbleRadius * 2,
        height: bubbleRadius * 2,
        borderRadius: '50%',
        background: color.bg,
        border: `1.5px solid ${color.border}`,
        zIndex: -1,
        pointerEvents: 'none' as const,
      },
      data: { label: '' },
      selectable: false,
      draggable: false,
    });

    // Service label
    rfNodes.push({
      id: `label-${service}`,
      type: 'default',
      position: { x: centerX - 50, y: centerY - bubbleRadius - 30 },
      style: {
        background: 'transparent',
        border: 'none',
        color: color.label,
        fontSize: '12px',
        fontWeight: 700,
        fontFamily: "'JetBrains Mono', monospace",
        letterSpacing: '0.08em',
        textTransform: 'uppercase' as const,
        width: 100,
        textAlign: 'center' as const,
        pointerEvents: 'none' as const,
      },
      data: { label: service },
      selectable: false,
      draggable: false,
    });

    // Place function nodes hierarchically within the bubble
    const topY = centerY - (totalLevels - 1) * NODE_V_SPACING / 2;

    for (let lvl = 0; lvl <= maxLevel; lvl++) {
      const group = levelGroups[lvl] || [];
      const rowY = topY + lvl * NODE_V_SPACING;
      const rowStartX = centerX - (group.length - 1) * NODE_H_SPACING / 2;

      group.forEach((nodeData, i) => {
        const nodeId = `${service}::${nodeData.function}`;
        rfNodes.push({
          id: nodeId,
          type: 'functionNode',
          position: { x: rowStartX + i * NODE_H_SPACING - 36, y: rowY - 36 },
          data: {
            label: nodeData.function,
            totalCalls: nodeData.total_calls,
            errorCount: nodeData.error_count,
            avgLatency: nodeData.avg_latency_ms,
            isEntryPoint: nodeData.is_entry_point,
            externalCalls: nodeData.external_calls || [],
            errorThresholdPct: 10,
            serviceName: service,
            serviceColor: color.label,
          },
        });

        // Track inter-service calls
        for (const ec of (nodeData.external_calls || [])) {
          if (ec === 'database') continue;
          for (const other of datasets) {
            if (other.service !== service) {
              interServiceEdges.add(`${service}->${other.service}`);
            }
          }
        }
      });
    }

    // Intra-service edges
    const maxEdgeCount = Math.max(1, ...(data.edges || []).map(e => e.count));
    for (const edge of (data.edges || [])) {
      const thickness = 1 + (edge.count / maxEdgeCount) * 3.5;
      rfEdges.push({
        id: `${service}::${edge.from}->${edge.to}`,
        source: `${service}::${edge.from}`,
        target: `${service}::${edge.to}`,
        type: 'default', // bezier
        style: {
          strokeWidth: thickness,
          stroke: color.edge,
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: color.edge,
          width: 8,
          height: 8,
        },
      });
    }
  });

  // Inter-service edges: ONE edge per pair of communicating services
  const addedPairs = new Set<string>();
  for (const key of Array.from(interServiceEdges)) {
    const [from, to] = key.split('->');
    const pairKey = [from, to].sort().join('<>');
    if (addedPairs.has(pairKey)) continue;
    addedPairs.add(pairKey);

    if (!serviceCenters[from] || !serviceCenters[to]) continue;

    // Create invisible anchor nodes at bubble edges for clean edge routing
    const fromC = serviceCenters[from];
    const toC = serviceCenters[to];
    const angle = Math.atan2(toC.y - fromC.y, toC.x - fromC.x);
    const reverseAngle = angle + Math.PI;

    const anchorFromId = `anchor-${from}-to-${to}`;
    const anchorToId = `anchor-${to}-from-${from}`;
    const anchorR = 200; // roughly at bubble edge

    rfNodes.push({
      id: anchorFromId,
      type: 'default',
      position: {
        x: fromC.x + anchorR * Math.cos(angle) - 2,
        y: fromC.y + anchorR * Math.sin(angle) - 2,
      },
      style: { width: 4, height: 4, background: 'rgba(250,204,21,0.6)', borderRadius: '50%', border: 'none', padding: 0 },
      data: { label: '' },
      selectable: false,
      draggable: false,
    });

    rfNodes.push({
      id: anchorToId,
      type: 'default',
      position: {
        x: toC.x + anchorR * Math.cos(reverseAngle) - 2,
        y: toC.y + anchorR * Math.sin(reverseAngle) - 2,
      },
      style: { width: 4, height: 4, background: 'rgba(250,204,21,0.6)', borderRadius: '50%', border: 'none', padding: 0 },
      data: { label: '' },
      selectable: false,
      draggable: false,
    });

    rfEdges.push({
      id: `inter-${from}<>${to}`,
      source: anchorFromId,
      target: anchorToId,
      type: 'straight',
      animated: true,
      style: {
        strokeWidth: 2,
        stroke: 'rgba(250, 204, 21, 0.35)',
      },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: 'rgba(250, 204, 21, 0.5)',
        width: 10,
        height: 10,
      },
    });
  }

  return { nodes: rfNodes, edges: rfEdges };
}

const ServiceGraph: React.FC<ServiceGraphProps> = ({ datasets, onNodeClick, errorThresholdPct }) => {
  const { nodes: layoutedNodes, edges: layoutedEdges } = useMemo(
    () => layoutGraph(datasets),
    [datasets]
  );

  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const prevStructure = useRef('');

  useEffect(() => {
    // Build a structural key: node IDs sorted
    const structureKey = layoutedNodes
      .filter(n => n.type === 'functionNode')
      .map(n => n.id)
      .sort()
      .join(',');

    const structureChanged = structureKey !== prevStructure.current;
    prevStructure.current = structureKey;

    if (structureChanged || nodes.length === 0) {
      // Full layout reset
      setNodes(layoutedNodes.map(n => ({
        ...n,
        data: n.type === 'functionNode' ? { ...n.data, errorThresholdPct } : n.data,
      })));
    } else {
      // Only update data (counts, errors, latency) — keep positions stable
      setNodes(prev => {
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
    }
    setEdges(layoutedEdges);
  }, [layoutedNodes, layoutedEdges, errorThresholdPct, setNodes, setEdges]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      if (!node.id.includes('::')) return;
      const parts = node.id.split('::');
      if (parts.length === 2) onNodeClick(parts[1], parts[0]);
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
      fitViewOptions={{ padding: 0.35 }}
      minZoom={0.15}
      maxZoom={2.5}
      connectionLineType={ConnectionLineType.SmoothStep}
      proOptions={{ hideAttribution: true }}
    >
      <Background color="rgba(255,255,255,0.02)" gap={30} />
      <Controls showInteractive={false} />
      <MiniMap
        nodeColor={(n) => {
          if (n.id.startsWith('bubble-') || n.id.startsWith('label-') || n.id.startsWith('anchor-')) return 'transparent';
          const d = n.data as any;
          if (d?.errorCount > 0) return '#ef4444';
          if (d?.serviceColor) return d.serviceColor;
          return '#52525b';
        }}
        maskColor="rgba(0,0,0,0.8)"
        style={{ background: 'rgba(15,15,25,0.9)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 8 }}
      />
    </ReactFlow>
  );
};

export default ServiceGraph;
