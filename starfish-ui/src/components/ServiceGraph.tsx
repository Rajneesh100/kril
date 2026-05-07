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

// Grafana data-viz series colors
const SERVICE_COLORS = [
  { label: '#6e9fff', border: 'rgba(110,159,255,0.18)', bg: 'rgba(110,159,255,0.02)' },
  { label: '#73BF69', border: 'rgba(115,191,105,0.18)', bg: 'rgba(115,191,105,0.02)' },
  { label: '#FF9830', border: 'rgba(255,152,48,0.18)', bg: 'rgba(255,152,48,0.02)' },
  { label: '#B877D9', border: 'rgba(184,119,217,0.18)', bg: 'rgba(184,119,217,0.02)' },
  { label: '#36A2EB', border: 'rgba(54,162,235,0.18)', bg: 'rgba(54,162,235,0.02)' },
];

// Grafana-style thin gray for edges
const EDGE_COLOR = 'rgba(142, 147, 156, 0.35)';
const EDGE_ARROW_COLOR = 'rgba(142, 147, 156, 0.5)';
const CROSS_EDGE_COLOR = 'rgba(255, 152, 48, 0.4)';

function layoutGraph(
  datasets: { service: string; data: ExecutionMapResponse }[]
): { nodes: Node[]; edges: Edge[] } {
  if (datasets.length === 0) return { nodes: [], edges: [] };

  const rfNodes: Node[] = [];
  const rfEdges: Edge[] = [];
  const BUBBLE_GAP = 700;

  const serviceCenters: Record<string, { x: number; y: number; radius: number }> = {};
  const serviceEntryNodes: Record<string, string[]> = {};
  const portToService: Record<string, string> = {};
  const allServices = datasets.map(d => d.service);
  const crossServiceCalls: { sourceId: string; targetService: string; url: string }[] = [];
  const dbSources: Record<string, Set<string>> = {};

  // Build port mapping
  datasets.forEach(({ service, data }) => {
    if (!data?.nodes) return;
    for (const node of data.nodes) {
      for (const ec of (node.external_calls || [])) {
        if (ec === 'database') continue;
        const m = ec.match(/:(\d{4})/);
        if (m && !portToService[m[1]]) {
          const idx = parseInt(m[1]) - 8081;
          if (idx >= 0 && idx < allServices.length) portToService[m[1]] = allServices[idx];
        }
      }
    }
  });

  datasets.forEach(({ service, data }, svcIdx) => {
    if (!data?.nodes?.length) return;

    const color = SERVICE_COLORS[svcIdx % SERVICE_COLORS.length];
    const centerX = svcIdx * BUBBLE_GAP;
    const centerY = 0;

    // BFS
    const children: Record<string, string[]> = {};
    const parentOf: Record<string, string[]> = {};
    for (const edge of (data.edges || [])) {
      if (!children[edge.from]) children[edge.from] = [];
      children[edge.from].push(edge.to);
      if (!parentOf[edge.to]) parentOf[edge.to] = [];
      parentOf[edge.to].push(edge.from);
    }

    const entryFunctions = data.nodes
      .filter(n => n.is_entry_point || !parentOf[n.function]?.length)
      .map(n => n.function).sort();

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

    const NODE_H_GAP = 150;
    const NODE_V_GAP = 120;
    const contentW = maxNodesInLevel * NODE_H_GAP;
    const contentH = totalLevels * NODE_V_GAP;
    const bubbleRadius = Math.max(200, Math.max(contentW, contentH) / 2 + 90);

    serviceCenters[service] = { x: centerX, y: centerY, radius: bubbleRadius };
    serviceEntryNodes[service] = entryFunctions.map(f => `${service}::${f}`);

    // Bubble — very subtle
    rfNodes.push({
      id: `bubble-${service}`,
      type: 'group',
      position: { x: centerX - bubbleRadius, y: centerY - bubbleRadius },
      style: {
        width: bubbleRadius * 2, height: bubbleRadius * 2,
        borderRadius: '50%',
        background: color.bg,
        border: `1px solid ${color.border}`,
        zIndex: -1,
        pointerEvents: 'none' as const,
      },
      data: { label: '' }, selectable: false, draggable: false,
    });

    // Service label
    rfNodes.push({
      id: `label-${service}`,
      type: 'default',
      position: { x: centerX - 50, y: centerY - bubbleRadius - 26 },
      style: {
        background: 'transparent', border: 'none',
        color: color.label,
        fontSize: '11px', fontWeight: 600,
        fontFamily: "'Inter', sans-serif",
        letterSpacing: '0.04em',
        textTransform: 'uppercase' as const,
        width: 100, textAlign: 'center' as const,
        pointerEvents: 'none' as const,
      },
      data: { label: service }, selectable: false, draggable: false,
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

        rfNodes.push({
          id: nodeId,
          type: 'functionNode',
          position: { x: px - 36, y: rowY - 36 },
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

        for (const ec of (nodeData.external_calls || [])) {
          if (ec.toLowerCase() === 'database' || ec.toLowerCase().includes('db')) {
            if (!dbSources[service]) dbSources[service] = new Set();
            dbSources[service].add(nodeId);
          } else {
            const m = ec.match(/:(\d{4})/);
            if (m && portToService[m[1]] && portToService[m[1]] !== service) {
              crossServiceCalls.push({ sourceId: nodeId, targetService: portToService[m[1]], url: ec });
            }
          }
        }
      });
    }

    // Intra-service edges — Grafana style: thin, gray, with small arrows
    const maxEdgeCount = Math.max(1, ...(data.edges || []).map(e => e.count));
    for (const edge of (data.edges || [])) {
      const ratio = edge.count / maxEdgeCount;
      // Grafana uses uniform thin edges, but we vary slightly for frequency
      const thickness = 1 + ratio * 1.5; // 1px to 2.5px — subtle
      rfEdges.push({
        id: `${service}::${edge.from}->${edge.to}`,
        source: `${service}::${edge.from}`,
        target: `${service}::${edge.to}`,
        type: 'default',
        style: { strokeWidth: thickness, stroke: EDGE_COLOR },
        markerEnd: { type: MarkerType.ArrowClosed, color: EDGE_ARROW_COLOR, width: 8, height: 8 },
      });
    }
  });

  // DB barrel nodes — one per service
  for (const [service, sources] of Object.entries(dbSources)) {
    const sc = serviceCenters[service];
    if (!sc) continue;
    const dbId = `db-${service}`;
    rfNodes.push({
      id: dbId, type: 'default',
      position: { x: sc.x - 20, y: sc.y + sc.radius + 45 },
      style: {
        width: 40, height: 28,
        borderRadius: '3px 3px 8px 8px',
        background: '#1a1d24',
        border: '1px solid #2c2f35',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: '10px', fontWeight: 500,
        fontFamily: "'Inter', sans-serif",
        color: '#8e939c', padding: 0,
      },
      data: { label: 'DB' }, selectable: false, draggable: false,
    });

    for (const src of Array.from(sources)) {
      rfEdges.push({
        id: `${src}->db-${service}`,
        source: src, target: dbId, type: 'default',
        style: { strokeWidth: 1, stroke: EDGE_COLOR, strokeDasharray: '5 3' },
      });
    }
  }

  // Cross-service edges
  const addedPairs = new Set<string>();
  for (const call of crossServiceCalls) {
    const entries = serviceEntryNodes[call.targetService];
    if (!entries?.length) continue;
    const targetNodeId = entries[0];
    const edgeKey = `${call.sourceId}->${call.targetService}`;
    if (addedPairs.has(edgeKey)) continue;
    addedPairs.add(edgeKey);

    const srcSvc = call.sourceId.split('::')[0];
    const srcC = serviceCenters[srcSvc];
    const tgtC = serviceCenters[call.targetService];
    if (!srcC || !tgtC) continue;

    const angle = Math.atan2(tgtC.y - srcC.y, tgtC.x - srcC.x);
    const revAngle = angle + Math.PI;
    const srcAnchor = `anc-s-${call.sourceId}-${call.targetService}`;
    const tgtAnchor = `anc-t-${call.sourceId}-${call.targetService}`;

    // Small dots at perimeter
    const dotStyle = {
      width: 5, height: 5, borderRadius: '50%',
      background: CROSS_EDGE_COLOR, border: 'none', padding: 0,
    };

    rfNodes.push({
      id: srcAnchor, type: 'default',
      position: {
        x: srcC.x + (srcC.radius - 8) * Math.cos(angle) - 2,
        y: srcC.y + (srcC.radius - 8) * Math.sin(angle) - 2,
      },
      style: dotStyle, data: { label: '' }, selectable: false, draggable: false,
    });

    rfNodes.push({
      id: tgtAnchor, type: 'default',
      position: {
        x: tgtC.x + (tgtC.radius - 8) * Math.cos(revAngle) - 2,
        y: tgtC.y + (tgtC.radius - 8) * Math.sin(revAngle) - 2,
      },
      style: dotStyle, data: { label: '' }, selectable: false, draggable: false,
    });

    // source fn -> src anchor
    rfEdges.push({
      id: `cx-a-${edgeKey}`, source: call.sourceId, target: srcAnchor,
      type: 'default',
      style: { strokeWidth: 1, stroke: CROSS_EDGE_COLOR, strokeDasharray: '4 3' },
    });
    // src anchor -> tgt anchor (animated)
    rfEdges.push({
      id: `cx-b-${edgeKey}`, source: srcAnchor, target: tgtAnchor,
      type: 'straight', animated: true,
      style: { strokeWidth: 1.5, stroke: CROSS_EDGE_COLOR },
      markerEnd: { type: MarkerType.ArrowClosed, color: CROSS_EDGE_COLOR, width: 8, height: 8 },
    });
    // tgt anchor -> target entry
    rfEdges.push({
      id: `cx-c-${edgeKey}`, source: tgtAnchor, target: targetNodeId,
      type: 'default',
      style: { strokeWidth: 1, stroke: CROSS_EDGE_COLOR, strokeDasharray: '4 3' },
    });
  }

  return { nodes: rfNodes, edges: rfEdges };
}

const ServiceGraph: React.FC<ServiceGraphProps> = ({ datasets, onNodeClick, errorThresholdPct }) => {
  const { nodes: laid, edges: laidEdges } = useMemo(() => layoutGraph(datasets), [datasets]);
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const prevKey = useRef('');

  useEffect(() => {
    const key = laid.filter(n => n.type === 'functionNode').map(n => n.id).sort().join(',');
    const changed = key !== prevKey.current;
    prevKey.current = key;

    if (changed || nodes.length === 0) {
      setNodes(laid.map(n => ({ ...n, data: n.type === 'functionNode' ? { ...n.data, errorThresholdPct } : n.data })));
    } else {
      setNodes(prev => {
        const m = new Map(prev.map(n => [n.id, n]));
        return laid.map(n => ({
          ...n,
          position: m.get(n.id)?.position || n.position,
          data: n.type === 'functionNode' ? { ...n.data, errorThresholdPct } : n.data,
        }));
      });
    }
    setEdges(laidEdges);
  }, [laid, laidEdges, errorThresholdPct, setNodes, setEdges]); // eslint-disable-line

  const onClick = useCallback((_: React.MouseEvent, node: Node) => {
    if (!node.id.includes('::')) return;
    const [svc, fn] = node.id.split('::');
    if (svc && fn) onNodeClick(fn, svc);
  }, [onNodeClick]);

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
      nodes={nodes} edges={edges}
      onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
      onNodeClick={onClick}
      nodeTypes={nodeTypes}
      fitView fitViewOptions={{ padding: 0.3 }}
      minZoom={0.1} maxZoom={3}
      connectionLineType={ConnectionLineType.SmoothStep}
      proOptions={{ hideAttribution: true }}
    >
      <Background color="rgba(255,255,255,0.02)" gap={24} size={1} />
      <Controls showInteractive={false} />
      <MiniMap
        nodeColor={n => {
          if (n.id.startsWith('bubble-') || n.id.startsWith('label-') || n.id.startsWith('anc-')) return 'transparent';
          if (n.id.startsWith('db-')) return '#3d71d9';
          const d = n.data as any;
          if (d?.errorCount > 0) return '#F2495C';
          if (d?.serviceColor) return d.serviceColor;
          return '#44474e';
        }}
        maskColor="rgba(0,0,0,0.75)"
        style={{ background: '#181b1f', border: '1px solid #2c2f35', borderRadius: 4 }}
      />
    </ReactFlow>
  );
};

export default ServiceGraph;
