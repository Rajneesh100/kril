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

// Color palette for service bubbles
const SERVICE_COLORS = [
  { border: 'rgba(99, 102, 241, 0.5)', bg: 'rgba(99, 102, 241, 0.04)', label: '#6366f1' },
  { border: 'rgba(34, 197, 94, 0.5)', bg: 'rgba(34, 197, 94, 0.04)', label: '#22c55e' },
  { border: 'rgba(249, 115, 22, 0.5)', bg: 'rgba(249, 115, 22, 0.04)', label: '#f97316' },
  { border: 'rgba(236, 72, 153, 0.5)', bg: 'rgba(236, 72, 153, 0.04)', label: '#ec4899' },
  { border: 'rgba(14, 165, 233, 0.5)', bg: 'rgba(14, 165, 233, 0.04)', label: '#0ea5e9' },
];

function layoutMultiService(
  datasets: { service: string; data: ExecutionMapResponse }[]
): { nodes: Node[]; edges: Edge[] } {
  if (datasets.length === 0) return { nodes: [], edges: [] };

  const rfNodes: Node[] = [];
  const rfEdges: Edge[] = [];
  const SERVICE_GAP = 600; // horizontal gap between service clusters

  // Track all external call sources across services for inter-service edges
  const externalCallMap: Record<string, { source: string; service: string }[]> = {};
  // Track which service owns which endpoint for inter-service connections
  const endpointToService: Record<string, string> = {};

  datasets.forEach(({ service, data }, svcIdx) => {
    if (!data || !data.nodes || data.nodes.length === 0) return;

    const color = SERVICE_COLORS[svcIdx % SERVICE_COLORS.length];
    const svcOffsetX = svcIdx * SERVICE_GAP;
    const maxEdgeCount = Math.max(1, ...(data.edges || []).map(e => e.count));

    // Register service endpoints
    for (const node of data.nodes) {
      if (node.is_entry_point) {
        endpointToService[service] = service;
      }
    }

    // Build adjacency
    const children: Record<string, string[]> = {};
    const parents: Record<string, string[]> = {};
    for (const edge of (data.edges || [])) {
      if (!children[edge.from]) children[edge.from] = [];
      children[edge.from].push(edge.to);
      if (!parents[edge.to]) parents[edge.to] = [];
      parents[edge.to].push(edge.from);
    }

    const entryPoints = data.nodes.filter(n => n.is_entry_point).map(n => n.function);
    if (entryPoints.length === 0) {
      const roots = data.nodes.filter(n => !parents[n.function] || parents[n.function].length === 0);
      entryPoints.push(...roots.map(n => n.function));
    }

    // BFS levels
    const levels: Record<string, number> = {};
    const queue = [...entryPoints];
    for (const ep of entryPoints) levels[ep] = 0;
    while (queue.length > 0) {
      const fn = queue.shift()!;
      const level = levels[fn];
      for (const child of (children[fn] || [])) {
        if (levels[child] === undefined || levels[child] < level + 1) {
          levels[child] = level + 1;
          queue.push(child);
        }
      }
    }
    for (const node of data.nodes) {
      if (levels[node.function] === undefined) levels[node.function] = 0;
    }

    // Group by level
    const levelGroups: Record<number, NodeStats[]> = {};
    for (const node of data.nodes) {
      const lvl = levels[node.function];
      if (!levelGroups[lvl]) levelGroups[lvl] = [];
      levelGroups[lvl].push(node);
    }

    const LEVEL_SPACING = 150;
    const NODE_SPACING = 170;
    const maxLevel = Math.max(0, ...Object.keys(levelGroups).map(Number));

    // Add service bubble (group node)
    const bubbleWidth = Math.max(300, (Math.max(...Object.values(levelGroups).map(g => g.length)) * NODE_SPACING) + 80);
    const bubbleHeight = (maxLevel + 1) * LEVEL_SPACING + 100;
    rfNodes.push({
      id: `bubble-${service}`,
      type: 'group',
      position: { x: svcOffsetX - bubbleWidth / 2, y: -60 },
      style: {
        width: bubbleWidth,
        height: bubbleHeight,
        background: color.bg,
        border: `2px dashed ${color.border}`,
        borderRadius: '24px',
        padding: '12px',
        zIndex: -1,
      },
      data: { label: '' },
      selectable: false,
      draggable: false,
    });

    // Add service label node
    rfNodes.push({
      id: `label-${service}`,
      type: 'default',
      position: { x: svcOffsetX - 50, y: -50 },
      style: {
        background: 'transparent',
        border: 'none',
        color: color.label,
        fontSize: '14px',
        fontWeight: 700,
        letterSpacing: '0.05em',
        textTransform: 'uppercase' as const,
        width: 'auto',
        pointerEvents: 'none' as const,
      },
      data: { label: service },
      selectable: false,
      draggable: false,
    });

    // Add function nodes
    for (let lvl = 0; lvl <= maxLevel; lvl++) {
      const group = levelGroups[lvl] || [];
      const startX = svcOffsetX - (group.length - 1) * NODE_SPACING / 2;

      group.forEach((nodeData, i) => {
        const nodeId = `${service}::${nodeData.function}`;
        rfNodes.push({
          id: nodeId,
          type: 'functionNode',
          position: { x: startX + i * NODE_SPACING, y: lvl * LEVEL_SPACING },
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

        // Track external calls for inter-service edges
        for (const ec of (nodeData.external_calls || [])) {
          if (!externalCallMap[ec]) externalCallMap[ec] = [];
          externalCallMap[ec].push({ source: nodeId, service });
        }
      });
    }

    // Add intra-service edges
    for (const edge of (data.edges || [])) {
      const thickness = 1 + (edge.count / maxEdgeCount) * 5;
      rfEdges.push({
        id: `${service}::${edge.from}->${edge.to}`,
        source: `${service}::${edge.from}`,
        target: `${service}::${edge.to}`,
        style: {
          strokeWidth: thickness,
          stroke: color.border,
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: color.border,
          width: 12,
          height: 12,
        },
      });
    }

    // Add external call nodes (database / external APIs) at the bottom of this service
    const allExternals = new Set<string>();
    const extSources: Record<string, string[]> = {};
    for (const node of data.nodes) {
      for (const ec of (node.external_calls || [])) {
        // Skip calls to other selected services (will become inter-service edges)
        const isInterService = datasets.some(d =>
          d.service !== service && ec.includes(`:808`)
        );
        if (!isInterService || ec === 'database') {
          allExternals.add(ec);
          if (!extSources[ec]) extSources[ec] = [];
          extSources[ec].push(`${service}::${node.function}`);
        }
      }
    }

    const extList = Array.from(allExternals);
    const extY = (maxLevel + 1.5) * LEVEL_SPACING;
    const extStartX = svcOffsetX - (extList.length - 1) * NODE_SPACING / 2;

    extList.forEach((ec, i) => {
      const isDb = ec.toLowerCase() === 'database' || ec.toLowerCase().includes('db');
      const extId = `${service}::ext-${ec}`;
      rfNodes.push({
        id: extId,
        type: 'externalNode',
        position: { x: extStartX + i * (NODE_SPACING * 0.8), y: extY },
        data: {
          label: isDb ? 'database' : ec.length > 25 ? ec.substring(0, 25) + '...' : ec,
          isDatabase: isDb,
        },
      });

      for (const source of (extSources[ec] || [])) {
        rfEdges.push({
          id: `${source}->ext-${ec}`,
          source,
          target: extId,
          animated: true,
          style: {
            strokeWidth: 1,
            stroke: 'rgba(161, 161, 170, 0.3)',
            strokeDasharray: '4 4',
          },
        });
      }
    });
  });

  // Add inter-service edges (calls from service A to service B)
  if (datasets.length > 1) {
    for (const [url, sources] of Object.entries(externalCallMap)) {
      if (url === 'database') continue;
      // Find target service by matching port in the URL
      for (const targetDs of datasets) {
        if (sources.some(s => s.service === targetDs.service)) continue;
        // Find an entry-point node in target service
        const targetEntries = targetDs.data.nodes?.filter(n => n.is_entry_point) || [];
        if (targetEntries.length > 0) {
          for (const src of sources) {
            // Check if URL matches this target service (heuristic: port-based)
            const targetNodeId = `${targetDs.service}::${targetEntries[0].function}`;
            rfEdges.push({
              id: `inter-${src.source}->${targetNodeId}-${url}`,
              source: src.source,
              target: targetNodeId,
              animated: true,
              style: {
                strokeWidth: 2,
                stroke: 'rgba(250, 204, 21, 0.5)',
              },
              markerEnd: {
                type: MarkerType.ArrowClosed,
                color: 'rgba(250, 204, 21, 0.5)',
                width: 14,
                height: 14,
              },
              label: url.replace(/https?:\/\/localhost:\d+/, ''),
              labelStyle: { fill: 'rgba(250, 204, 21, 0.7)', fontSize: 10 },
              labelBgStyle: { fill: 'rgba(10, 10, 15, 0.8)' },
            });
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

  // Update nodes/edges when layout changes
  useEffect(() => {
    setNodes(layoutedNodes.map(n => ({
      ...n,
      data: n.type === 'functionNode' ? { ...n.data, errorThresholdPct } : n.data,
    })));
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
      fitViewOptions={{ padding: 0.3 }}
      minZoom={0.1}
      maxZoom={2.5}
      defaultEdgeOptions={{ type: 'smoothstep' }}
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
