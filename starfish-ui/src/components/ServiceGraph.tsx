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

// Grafana data visualization palette
const SERVICE_COLORS = [
  { border: 'rgba(110, 159, 255, 0.25)', bg: 'rgba(61, 113, 217, 0.03)', label: '#6e9fff', edge: 'rgba(110, 159, 255, 0.22)' },
  { border: 'rgba(108, 207, 142, 0.25)', bg: 'rgba(26, 127, 75, 0.03)', label: '#6ccf8e', edge: 'rgba(108, 207, 142, 0.22)' },
  { border: 'rgba(251, 173, 55, 0.25)', bg: 'rgba(255, 153, 0, 0.03)', label: '#fbad37', edge: 'rgba(251, 173, 55, 0.22)' },
  { border: 'rgba(194, 122, 255, 0.25)', bg: 'rgba(194, 122, 255, 0.03)', label: '#C27AFF', edge: 'rgba(194, 122, 255, 0.22)' },
  { border: 'rgba(255, 82, 134, 0.25)', bg: 'rgba(209, 14, 92, 0.03)', label: '#ff5286', edge: 'rgba(255, 82, 134, 0.22)' },
];

/**
 * Builds a complete graph with:
 * 1. Hierarchical execution flow inside circular service bubbles
 * 2. Database barrel nodes at the perimeter
 * 3. Cross-service edges connecting the exact calling function to the target
 *    service entry-point, routed through perimeter anchor points
 */
function layoutGraph(
  datasets: { service: string; data: ExecutionMapResponse }[]
): { nodes: Node[]; edges: Edge[] } {
  if (datasets.length === 0) return { nodes: [], edges: [] };

  const rfNodes: Node[] = [];
  const rfEdges: Edge[] = [];
  const BUBBLE_GAP = 700;

  // Maps for cross-service routing
  const serviceCenters: Record<string, { x: number; y: number; radius: number }> = {};
  // Map: "port" -> service name (for matching external call URLs)
  const portToService: Record<string, string> = {};
  // Map: service -> list of entry point node IDs
  const serviceEntryNodes: Record<string, string[]> = {};
  // Map: nodeId -> position (for anchor calculation)
  const nodePositions: Record<string, { x: number; y: number }> = {};
  // Track cross-service calls: { sourceNodeId, targetService, url }
  const crossServiceCalls: { sourceId: string; targetService: string; url: string }[] = [];
  // Track db calls: { sourceNodeId }
  const dbCalls: { sourceId: string; service: string }[] = [];

  // First pass: build port mapping from external call URLs
  // We infer: service_a on 8081, service_b on 8082, etc.
  // by looking at which ports appear in external_calls across all services
  const allServices = datasets.map(d => d.service);

  datasets.forEach(({ service, data }, svcIdx) => {
    if (!data?.nodes) return;
    for (const node of data.nodes) {
      for (const ec of (node.external_calls || [])) {
        if (ec === 'database') continue;
        const portMatch = ec.match(/:(\d{4})/);
        if (portMatch) {
          const port = portMatch[1];
          // Heuristic: assign ports to services in order
          // In production this would be config-based
          if (!portToService[port]) {
            const targetIdx = parseInt(port) - 8081; // 8081->0, 8082->1, 8083->2
            if (targetIdx >= 0 && targetIdx < allServices.length) {
              portToService[port] = allServices[targetIdx];
            }
          }
        }
      }
    }
  });

  // Second pass: layout each service
  datasets.forEach(({ service, data }, svcIdx) => {
    if (!data?.nodes?.length) return;

    const color = SERVICE_COLORS[svcIdx % SERVICE_COLORS.length];
    const centerX = svcIdx * BUBBLE_GAP;
    const centerY = 0;

    // --- BFS hierarchical layout ---
    const children: Record<string, string[]> = {};
    const parentOf: Record<string, string[]> = {};
    for (const edge of (data.edges || [])) {
      if (!children[edge.from]) children[edge.from] = [];
      children[edge.from].push(edge.to);
      if (!parentOf[edge.to]) parentOf[edge.to] = [];
      parentOf[edge.to].push(edge.from);
    }

    // Entry points: marked as entry OR has no parent edges
    const entryFunctions = data.nodes
      .filter(n => n.is_entry_point || !parentOf[n.function]?.length)
      .map(n => n.function)
      .sort();

    // BFS levels
    const levels: Record<string, number> = {};
    const queue = [...entryFunctions];
    for (const ep of entryFunctions) levels[ep] = 0;
    while (queue.length > 0) {
      const fn = queue.shift()!;
      for (const child of (children[fn] || []).sort()) {
        if (levels[child] === undefined) {
          levels[child] = levels[fn] + 1;
          queue.push(child);
        }
      }
    }
    for (const n of data.nodes) {
      if (levels[n.function] === undefined) levels[n.function] = 0;
    }

    // Group by level, sort within each level
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

    // Sizing
    const NODE_H_GAP = 140;
    const NODE_V_GAP = 120;
    const contentWidth = maxNodesInLevel * NODE_H_GAP;
    const contentHeight = totalLevels * NODE_V_GAP;
    const bubbleRadius = Math.max(220, Math.max(contentWidth, contentHeight) / 2 + 80);

    serviceCenters[service] = { x: centerX, y: centerY, radius: bubbleRadius };
    serviceEntryNodes[service] = entryFunctions.map(f => `${service}::${f}`);

    // Circular bubble (Grafana-style: subtle, no heavy borders)
    rfNodes.push({
      id: `bubble-${service}`,
      type: 'group',
      position: { x: centerX - bubbleRadius, y: centerY - bubbleRadius },
      style: {
        width: bubbleRadius * 2,
        height: bubbleRadius * 2,
        borderRadius: '50%',
        background: color.bg,
        border: `1px solid ${color.border}`,
        zIndex: -1,
        pointerEvents: 'none' as const,
      },
      data: { label: '' },
      selectable: false,
      draggable: false,
    });

    // Service label (Grafana-style: small, muted)
    rfNodes.push({
      id: `label-${service}`,
      type: 'default',
      position: { x: centerX - 50, y: centerY - bubbleRadius - 28 },
      style: {
        background: 'transparent',
        border: 'none',
        color: color.label,
        fontSize: '11px',
        fontWeight: 600,
        fontFamily: "'JetBrains Mono', monospace",
        letterSpacing: '0.06em',
        textTransform: 'uppercase' as const,
        width: 100,
        textAlign: 'center' as const,
        pointerEvents: 'none' as const,
      },
      data: { label: service },
      selectable: false,
      draggable: false,
    });

    // Place function nodes
    const topY = centerY - (totalLevels - 1) * NODE_V_GAP / 2;
    for (let lvl = 0; lvl <= maxLevel; lvl++) {
      const group = levelGroups[lvl] || [];
      const rowY = topY + lvl * NODE_V_GAP;
      const rowStartX = centerX - (group.length - 1) * NODE_H_GAP / 2;

      group.forEach((nodeData, i) => {
        const nodeId = `${service}::${nodeData.function}`;
        const px = rowStartX + i * NODE_H_GAP;
        const py = rowY;
        nodePositions[nodeId] = { x: px, y: py };

        rfNodes.push({
          id: nodeId,
          type: 'functionNode',
          position: { x: px - 36, y: py - 36 },
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

        // Track cross-service and db calls
        for (const ec of (nodeData.external_calls || [])) {
          if (ec.toLowerCase() === 'database' || ec.toLowerCase().includes('db')) {
            dbCalls.push({ sourceId: nodeId, service });
          } else {
            const portMatch = ec.match(/:(\d{4})/);
            if (portMatch && portToService[portMatch[1]] && portToService[portMatch[1]] !== service) {
              crossServiceCalls.push({
                sourceId: nodeId,
                targetService: portToService[portMatch[1]],
                url: ec,
              });
            }
          }
        }
      });
    }

    // Intra-service edges (the execution flow — this is the core visualization)
    const maxEdgeCount = Math.max(1, ...(data.edges || []).map(e => e.count));
    for (const edge of (data.edges || [])) {
      const ratio = edge.count / maxEdgeCount;
      const thickness = 1.5 + ratio * 4; // 1.5px to 5.5px
      const opacity = 0.15 + ratio * 0.35; // more frequent = more visible
      rfEdges.push({
        id: `${service}::${edge.from}->${edge.to}`,
        source: `${service}::${edge.from}`,
        target: `${service}::${edge.to}`,
        type: 'default',
        style: {
          strokeWidth: thickness,
          stroke: color.edge.replace(/[\d.]+\)$/, `${opacity})`),
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: color.edge.replace(/[\d.]+\)$/, `${opacity + 0.1})`),
          width: 8,
          height: 8,
        },
      });
    }
  });

  // --- Database barrel nodes at the perimeter ---
  // Group db calls per service to avoid duplicates
  const dbPerService = new Map<string, Set<string>>();
  for (const dc of dbCalls) {
    if (!dbPerService.has(dc.service)) dbPerService.set(dc.service, new Set());
    dbPerService.get(dc.service)!.add(dc.sourceId);
  }

  for (const [service, sourceIds] of Array.from(dbPerService.entries())) {
    const sc = serviceCenters[service];
    if (!sc) continue;

    const dbNodeId = `db-${service}`;
    // Place barrel below the bubble
    const dbX = sc.x;
    const dbY = sc.y + sc.radius + 55;

    rfNodes.push({
      id: dbNodeId,
      type: 'default',
      position: { x: dbX - 22, y: dbY - 16 },
      style: {
        width: 40,
        height: 28,
        borderRadius: '3px 3px 8px 8px',
        background: '#22252b',
        border: '1px solid #383b42',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: '9px',
        fontWeight: 600,
        fontFamily: "'JetBrains Mono', monospace",
        color: '#6e9fff',
        padding: 0,
      },
      data: { label: 'DB' },
      selectable: false,
      draggable: false,
    });

    // Edges from each calling function to the DB barrel
    for (const sourceId of Array.from(sourceIds)) {
      rfEdges.push({
        id: `${sourceId}->db`,
        source: sourceId,
        target: dbNodeId,
        type: 'default',
        animated: false,
        style: {
          strokeWidth: 1,
          stroke: 'rgba(110, 159, 255, 0.12)',
          strokeDasharray: '6 3',
        },
      });
    }
  }

  // --- Cross-service edges ---
  // Connect the calling function to the target service's entry point
  // Route via the perimeter (anchor dots)
  const addedCrossEdges = new Set<string>();
  for (const call of crossServiceCalls) {
    const targetEntries = serviceEntryNodes[call.targetService];
    if (!targetEntries?.length) continue;

    // Match the URL endpoint to the right entry point if possible
    const pathMatch = call.url.match(/\/(api\d+)/);
    let targetNodeId = targetEntries[0]; // default to first entry
    if (pathMatch) {
      // Find an entry-point in the target service whose endpoint matches
      const ds = datasets.find(d => d.service === call.targetService);
      if (ds?.data?.nodes) {
        // Look through telemetry to find which function handles this endpoint
        // For now, just pick the first entry point (the data flows through it)
      }
    }

    const edgeKey = `${call.sourceId}->${targetNodeId}`;
    if (addedCrossEdges.has(edgeKey)) continue;
    addedCrossEdges.add(edgeKey);

    const srcCenter = serviceCenters[datasets.find(d => call.sourceId.startsWith(d.service))?.service || ''];
    const tgtCenter = serviceCenters[call.targetService];
    if (!srcCenter || !tgtCenter) continue;

    // Create perimeter anchor nodes
    const angleToTarget = Math.atan2(tgtCenter.y - srcCenter.y, tgtCenter.x - srcCenter.x);
    const angleFromSource = angleToTarget + Math.PI;

    const srcAnchorId = `anchor-src-${call.sourceId}-${call.targetService}`;
    const tgtAnchorId = `anchor-tgt-${call.sourceId}-${call.targetService}`;

    // Source anchor at source bubble perimeter
    rfNodes.push({
      id: srcAnchorId,
      type: 'default',
      position: {
        x: srcCenter.x + (srcCenter.radius - 10) * Math.cos(angleToTarget) - 3,
        y: srcCenter.y + (srcCenter.radius - 10) * Math.sin(angleToTarget) - 3,
      },
      style: {
        width: 6, height: 6, borderRadius: '50%',
        background: 'rgba(251, 173, 55, 0.5)',
        border: 'none', padding: 0,
      },
      data: { label: '' },
      selectable: false,
      draggable: false,
    });

    // Target anchor at target bubble perimeter
    rfNodes.push({
      id: tgtAnchorId,
      type: 'default',
      position: {
        x: tgtCenter.x + (tgtCenter.radius - 10) * Math.cos(angleFromSource) - 3,
        y: tgtCenter.y + (tgtCenter.radius - 10) * Math.sin(angleFromSource) - 3,
      },
      style: {
        width: 6, height: 6, borderRadius: '50%',
        background: 'rgba(251, 173, 55, 0.5)',
        border: 'none', padding: 0,
      },
      data: { label: '' },
      selectable: false,
      draggable: false,
    });

    // Edge: calling function -> source anchor
    rfEdges.push({
      id: `cross-a-${edgeKey}`,
      source: call.sourceId,
      target: srcAnchorId,
      type: 'default',
      style: { strokeWidth: 1.5, stroke: 'rgba(251, 173, 55, 0.18)', strokeDasharray: '4 3' },
    });

    // Edge: source anchor -> target anchor (the inter-service hop)
    rfEdges.push({
      id: `cross-b-${edgeKey}`,
      source: srcAnchorId,
      target: tgtAnchorId,
      type: 'straight',
      animated: true,
      style: { strokeWidth: 2, stroke: 'rgba(255, 153, 0, 0.3)' },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: 'rgba(255, 153, 0, 0.5)',
        width: 10,
        height: 10,
      },
      label: pathMatch ? pathMatch[0] : '',
      labelStyle: { fill: 'rgba(251, 173, 55, 0.6)', fontSize: 9, fontFamily: "'JetBrains Mono', monospace" },
      labelBgStyle: { fill: 'rgba(10, 10, 15, 0.85)', rx: 3 },
      labelBgPadding: [4, 2] as [number, number],
    });

    // Edge: target anchor -> target entry point
    rfEdges.push({
      id: `cross-c-${edgeKey}`,
      source: tgtAnchorId,
      target: targetNodeId,
      type: 'default',
      style: { strokeWidth: 1.5, stroke: 'rgba(251, 173, 55, 0.18)', strokeDasharray: '4 3' },
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
    const structureKey = layoutedNodes
      .filter(n => n.type === 'functionNode')
      .map(n => n.id)
      .sort()
      .join(',');

    const structureChanged = structureKey !== prevStructure.current;
    prevStructure.current = structureKey;

    if (structureChanged || nodes.length === 0) {
      setNodes(layoutedNodes.map(n => ({
        ...n,
        data: n.type === 'functionNode' ? { ...n.data, errorThresholdPct } : n.data,
      })));
    } else {
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
      fitViewOptions={{ padding: 0.3 }}
      minZoom={0.1}
      maxZoom={3}
      connectionLineType={ConnectionLineType.SmoothStep}
      proOptions={{ hideAttribution: true }}
    >
      <Background color="rgba(255,255,255,0.02)" gap={24} size={1} />
      <Controls showInteractive={false} />
      <MiniMap
        nodeColor={(n) => {
          if (n.id.startsWith('bubble-') || n.id.startsWith('label-') || n.id.startsWith('anchor-')) return 'transparent';
          if (n.id.startsWith('db-')) return '#6366f1';
          const d = n.data as any;
          if (d?.errorCount > 0) return '#ef4444';
          if (d?.serviceColor) return d.serviceColor;
          return '#52525b';
        }}
        maskColor="rgba(0,0,0,0.75)"
        style={{ background: '#181b1f', border: '1px solid #2c2f35', borderRadius: 4 }}
      />
    </ReactFlow>
  );
};

export default ServiceGraph;
