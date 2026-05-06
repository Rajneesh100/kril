import React, { useCallback, useMemo } from 'react';
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
  data: ExecutionMapResponse | null;
  onNodeClick: (functionName: string) => void;
  errorThresholdPct: number;
}

function layoutNodes(data: ExecutionMapResponse): { nodes: Node[]; edges: Edge[] } {
  if (!data || !data.nodes || data.nodes.length === 0) {
    return { nodes: [], edges: [] };
  }

  const maxEdgeCount = Math.max(1, ...data.edges.map(e => e.count));

  // Find entry points and build adjacency
  const children: Record<string, string[]> = {};
  const parents: Record<string, string[]> = {};
  for (const edge of data.edges) {
    if (!children[edge.from]) children[edge.from] = [];
    children[edge.from].push(edge.to);
    if (!parents[edge.to]) parents[edge.to] = [];
    parents[edge.to].push(edge.from);
  }

  const entryPoints = data.nodes.filter(n => n.is_entry_point).map(n => n.function);
  if (entryPoints.length === 0 && data.nodes.length > 0) {
    // Fallback: nodes with no parents
    const nodesWithNoParent = data.nodes.filter(n => !parents[n.function] || parents[n.function].length === 0);
    entryPoints.push(...nodesWithNoParent.map(n => n.function));
  }

  // BFS to assign levels
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

  // Assign levels to any remaining unvisited nodes
  for (const node of data.nodes) {
    if (levels[node.function] === undefined) {
      levels[node.function] = 0;
    }
  }

  // Group nodes by level
  const levelGroups: Record<number, NodeStats[]> = {};
  for (const node of data.nodes) {
    const lvl = levels[node.function];
    if (!levelGroups[lvl]) levelGroups[lvl] = [];
    levelGroups[lvl].push(node);
  }

  const LEVEL_SPACING = 140;
  const NODE_SPACING = 160;

  // Collect all external calls for creating external nodes
  const allExternals = new Set<string>();
  const externalSources: Record<string, string[]> = {};

  const rfNodes: Node[] = [];

  const maxLevel = Math.max(...Object.keys(levelGroups).map(Number));

  for (let lvl = 0; lvl <= maxLevel; lvl++) {
    const group = levelGroups[lvl] || [];
    const startX = -(group.length - 1) * NODE_SPACING / 2;

    group.forEach((nodeData, i) => {
      rfNodes.push({
        id: nodeData.function,
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
        },
      });

      // Track external calls
      for (const ec of (nodeData.external_calls || [])) {
        allExternals.add(ec);
        if (!externalSources[ec]) externalSources[ec] = [];
        externalSources[ec].push(nodeData.function);
      }
    });
  }

  // Add external call nodes at the bottom
  const extY = (maxLevel + 1.5) * LEVEL_SPACING;
  const extList = Array.from(allExternals);
  const extStartX = -(extList.length - 1) * NODE_SPACING / 2;

  extList.forEach((ec, i) => {
    const isDb = ec.toLowerCase() === 'database' || ec.toLowerCase().includes('db');
    rfNodes.push({
      id: `ext-${ec}`,
      type: 'externalNode',
      position: { x: extStartX + i * NODE_SPACING, y: extY },
      data: {
        label: isDb ? 'database' : ec.length > 20 ? ec.substring(0, 20) + '...' : ec,
        isDatabase: isDb,
      },
    });
  });

  // Build edges
  const rfEdges: Edge[] = [];

  for (const edge of data.edges) {
    const thickness = 1 + (edge.count / maxEdgeCount) * 5; // 1px to 6px
    rfEdges.push({
      id: `${edge.from}->${edge.to}`,
      source: edge.from,
      target: edge.to,
      animated: false,
      style: {
        strokeWidth: thickness,
        stroke: 'rgba(99, 102, 241, 0.4)',
      },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: 'rgba(99, 102, 241, 0.4)',
        width: 12,
        height: 12,
      },
    });
  }

  // External call edges
  for (const ec of extList) {
    for (const source of (externalSources[ec] || [])) {
      rfEdges.push({
        id: `${source}->ext-${ec}`,
        source: source,
        target: `ext-${ec}`,
        animated: true,
        style: {
          strokeWidth: 1,
          stroke: 'rgba(161, 161, 170, 0.3)',
          strokeDasharray: '4 4',
        },
      });
    }
  }

  return { nodes: rfNodes, edges: rfEdges };
}

const ServiceGraph: React.FC<ServiceGraphProps> = ({ data, onNodeClick, errorThresholdPct }) => {
  const { nodes: initialNodes, edges: initialEdges } = useMemo(
    () => layoutNodes(data!),
    [data]
  );

  const [nodes, , onNodesChange] = useNodesState(initialNodes);
  const [edges, , onEdgesChange] = useEdgesState(initialEdges);

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      if (!node.id.startsWith('ext-')) {
        onNodeClick(node.id);
      }
    },
    [onNodeClick]
  );

  if (!data || !data.nodes || data.nodes.length === 0) {
    return (
      <div className="empty-state">
        <div className="icon">⭐</div>
        <p>Select a service and time range to view the execution map</p>
      </div>
    );
  }

  return (
    <ReactFlow
      nodes={nodes.map(n => ({
        ...n,
        data: n.type === 'functionNode' ? { ...n.data, errorThresholdPct } : n.data,
      }))}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeClick={handleNodeClick}
      nodeTypes={nodeTypes}
      fitView
      fitViewOptions={{ padding: 0.3 }}
      minZoom={0.2}
      maxZoom={2}
      defaultEdgeOptions={{ type: 'smoothstep' }}
    >
      <Background color="rgba(255,255,255,0.03)" gap={24} />
      <Controls />
      <MiniMap
        nodeColor={(n) => {
          if (n.type === 'externalNode') return '#71717a';
          const d = n.data as any;
          if (d.errorCount > 0) return '#ef4444';
          if (d.isEntryPoint) return '#6366f1';
          return '#a1a1aa';
        }}
        maskColor="rgba(0,0,0,0.7)"
      />
    </ReactFlow>
  );
};

export default ServiceGraph;
