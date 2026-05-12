import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as d3 from 'd3';
import { ExecutionMapResponse, NodeStats } from '../api';

interface ServiceGraphProps {
  datasets: { service: string; data: ExecutionMapResponse }[];
  onNodeClick: (functionName: string, serviceName: string) => void;
  errorThresholdPct: number;
}

// Grafana data-viz palette
const SERVICE_COLORS = [
  { label: '#6e9fff', border: 'rgba(110,159,255,0.22)', bg: 'rgba(110,159,255,0.025)' },
  { label: '#73BF69', border: 'rgba(115,191,105,0.22)', bg: 'rgba(115,191,105,0.025)' },
  { label: '#FF9830', border: 'rgba(255,152,48,0.22)', bg: 'rgba(255,152,48,0.025)' },
  { label: '#B877D9', border: 'rgba(184,119,217,0.22)', bg: 'rgba(184,119,217,0.025)' },
  { label: '#36A2EB', border: 'rgba(54,162,235,0.22)', bg: 'rgba(54,162,235,0.025)' },
];

const EDGE_COLOR = 'rgba(142, 147, 156, 0.40)';
const CROSS_EDGE_COLOR = 'rgba(255, 152, 48, 0.75)';
const RED = '#F2495C';

// ─────────────────────────────────────────────────────────────────────────────
// Types

type ServiceInfo = {
  name: string;
  idx: number;
  cx: number;
  cy: number;
  radius: number;
  entryNodeId?: string;
};

type SimNode = d3.SimulationNodeDatum & {
  id: string;
  fn: string;
  service: string;
  serviceIdx: number;
  stats: NodeStats;
  isEntry: boolean;
  size: number;
  svc: ServiceInfo;            // live reference — drives forceX/Y target
};

type SimLink = d3.SimulationLinkDatum<SimNode> & {
  weight: number;
  cross?: boolean;
};

type CrossEdge = {
  sourceNodeId: string;
  targetNodeId: string;         // resolved target function id
};

type DBLink = {
  sourceNodeId: string;
  service: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// Build sim inputs from API datasets

function build(datasets: { service: string; data: ExecutionMapResponse }[]) {
  const nodes: SimNode[] = [];
  const links: SimLink[] = [];
  const services: ServiceInfo[] = [];
  const crossEdges: CrossEdge[] = [];
  const dbLinks: DBLink[] = [];

  const BUBBLE_GAP = 720;
  const allServices = datasets.map(d => d.service);

  // Port→service mapping (test services: 8081/8082/8083 by index)
  const portToService: Record<string, string> = {};
  datasets.forEach(({ data }) => {
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

  const entryByService = new Map<string, string>();

  datasets.forEach(({ service, data }, svcIdx) => {
    if (!data?.nodes?.length) return;

    const cx = svcIdx * BUBBLE_GAP;
    const cy = 0;
    const nodeCount = data.nodes.length;
    const radius = Math.max(190, Math.sqrt(nodeCount) * 60);

    const isChild: Record<string, boolean> = {};
    for (const e of (data.edges || [])) isChild[e.to] = true;
    const entryFn = data.nodes.find(n => n.is_entry_point || !isChild[n.function])?.function;

    const svc: ServiceInfo = {
      name: service,
      idx: svcIdx,
      cx, cy,
      radius,
      entryNodeId: entryFn ? `${service}::${entryFn}` : undefined,
    };
    services.push(svc);
    if (entryFn) entryByService.set(service, `${service}::${entryFn}`);

    for (const n of data.nodes) {
      const id = `${service}::${n.function}`;
      const isEntry = n.is_entry_point || n.function === entryFn;
      const size = isEntry ? 72 : 52;

      const a = Math.random() * Math.PI * 2;
      const r = radius * 0.35;
      nodes.push({
        id,
        fn: n.function,
        service,
        serviceIdx: svcIdx,
        stats: n,
        isEntry,
        size,
        svc,
        x: cx + Math.cos(a) * r,
        y: cy + Math.sin(a) * r,
      });

      for (const ec of (n.external_calls || [])) {
        const low = ec.toLowerCase();
        if (low === 'database' || low.includes('db')) {
          dbLinks.push({ sourceNodeId: id, service });
        } else {
          const m = ec.match(/:(\d{4})/);
          const tgtSvc = m && portToService[m[1]];
          if (tgtSvc && tgtSvc !== service) {
            const tgtEntry = entryByService.get(tgtSvc) || `${tgtSvc}::__entry__`;
            crossEdges.push({ sourceNodeId: id, targetNodeId: tgtEntry });
          }
        }
      }
    }

    for (const e of (data.edges || [])) {
      links.push({
        source: `${service}::${e.from}`,
        target: `${service}::${e.to}`,
        weight: e.count,
      });
    }
  });

  // Resolve cross edges — those built before target service was processed used a stub id
  const validIds = new Set(nodes.map(n => n.id));
  const resolvedCross = crossEdges.filter(c => {
    if (!c.targetNodeId.endsWith('::__entry__')) return validIds.has(c.targetNodeId);
    const svcName = c.targetNodeId.replace('::__entry__', '');
    const entry = entryByService.get(svcName);
    if (entry) { c.targetNodeId = entry; return true; }
    return false;
  });

  // Dedupe cross-edges
  const seen = new Set<string>();
  const uniqueCross = resolvedCross.filter(c => {
    const k = `${c.sourceNodeId}->${c.targetNodeId}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // Cross edges also feed the sim as weak links so endpoints orient toward each other
  for (const c of uniqueCross) {
    links.push({ source: c.sourceNodeId, target: c.targetNodeId, weight: 1, cross: true });
  }

  // Dedupe DB links
  const dbSeen = new Set<string>();
  const uniqueDb = dbLinks.filter(d => {
    const k = `${d.sourceNodeId}->${d.service}`;
    if (dbSeen.has(k)) return false;
    dbSeen.add(k);
    return true;
  });

  return { nodes, links, services, crossEdges: uniqueCross, dbLinks: uniqueDb };
}

// ─────────────────────────────────────────────────────────────────────────────
// Function node SVG — uniform service color, small red badge for errors

function FunctionNodeSVG({
  node, selected, errorThresholdPct, onClick,
}: {
  node: SimNode;
  selected: boolean;
  errorThresholdPct: number;
  onClick: () => void;
}) {
  const { size, stats, isEntry, x = 0, y = 0 } = node;
  const r = size / 2;
  const strokeW = 3;
  const innerR = r - strokeW / 2 - 1;

  const total = stats.total_calls || 1;
  const errorPct = (stats.error_count / total) * 100;
  const hasError = stats.error_count > 0;
  const overThreshold = errorPct >= errorThresholdPct;

  const serviceColor = SERVICE_COLORS[node.serviceIdx % SERVICE_COLORS.length].label;
  const latencyText = stats.avg_latency_ms < 1 ? '<1' : stats.avg_latency_ms.toFixed(1);

  return (
    <g
      transform={`translate(${x},${y})`}
      style={{ cursor: 'pointer' }}
      onClick={onClick}
    >
      <circle cx={0} cy={0} r={innerR} fill="#1a1d24" />
      <circle
        cx={0} cy={0} r={innerR}
        fill="none"
        stroke={serviceColor}
        strokeWidth={strokeW}
        opacity={0.95}
      />
      {selected && (
        <circle cx={0} cy={0} r={r} fill="none" stroke="#fff" strokeWidth={1.5} opacity={0.45} />
      )}

      {/* Error badge — small filled dot top-right */}
      {hasError && (
        <g transform={`translate(${r - 2},${-r + 2})`}>
          <circle r={6} fill={overThreshold ? RED : 'rgba(242,73,92,0.55)'} stroke="#0d0e10" strokeWidth={1.2} />
          <text textAnchor="middle" y={2.5} fontSize={8} fontFamily="'JetBrains Mono', monospace" fontWeight={600} fill="#fff">
            {Math.round(errorPct)}
          </text>
        </g>
      )}

      <text
        x={0} y={isEntry ? -3 : -2}
        textAnchor="middle"
        fontFamily="'JetBrains Mono', monospace"
        fontSize={isEntry ? 12 : 10}
        fontWeight={500}
        fill="#d8dade"
      >
        {latencyText}<tspan fontSize={isEntry ? 9 : 7.5} fill="#8e939c"> ms</tspan>
      </text>
      <text
        x={0} y={isEntry ? 11 : 10}
        textAnchor="middle"
        fontFamily="'JetBrains Mono', monospace"
        fontSize={isEntry ? 10 : 8.5}
        fill="#8e939c"
      >
        {stats.total_calls}<tspan fontSize="0.82em"> calls</tspan>
      </text>

      <text
        x={0} y={r + 14}
        textAnchor="middle"
        fontFamily="'Inter', sans-serif"
        fontSize={11}
        fill="#d8dade"
      >
        {node.fn.length > 16 ? node.fn.slice(0, 15) + '…' : node.fn}
      </text>
    </g>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main component

const ServiceGraph: React.FC<ServiceGraphProps> = ({ datasets, onNodeClick, errorThresholdPct }) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const simRef = useRef<d3.Simulation<SimNode, SimLink> | null>(null);

  const dragNodeRef = useRef<SimNode | null>(null);
  const dragBubbleRef = useRef<{
    svc: ServiceInfo;
    startCx: number; startCy: number;
    startWX: number; startWY: number;
  } | null>(null);

  const [transform, setTransform] = useState({ x: 0, y: 0, k: 1 });
  const transformRef = useRef({ x: 0, y: 0, k: 1 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [, forceTick] = useState(0);

  const built = useMemo(() => build(datasets), [datasets]);

  // Persist service bubble positions across data refetches so bubble drags survive polling
  const servicePosRef = useRef<Map<string, { cx: number; cy: number }>>(new Map());

  const nodesRef = useRef<SimNode[]>([]);
  const linksRef = useRef<SimLink[]>([]);

  useEffect(() => {
    // Restore saved bubble positions onto the freshly built services
    for (const svc of built.services) {
      const saved = servicePosRef.current.get(svc.name);
      if (saved) {
        svc.cx = saved.cx;
        svc.cy = saved.cy;
      } else {
        servicePosRef.current.set(svc.name, { cx: svc.cx, cy: svc.cy });
      }
    }

    // Build a map from new nodes' service -> the new ServiceInfo so each new node has a live svc ref
    const svcByName = new Map(built.services.map(s => [s.name, s]));
    for (const n of built.nodes) {
      const liveSvc = svcByName.get(n.service);
      if (liveSvc) n.svc = liveSvc;
    }

    // Carry positions/velocities forward by node id
    const prev = new Map(nodesRef.current.map(n => [n.id, n]));
    for (const n of built.nodes) {
      const old = prev.get(n.id);
      if (old && old.x != null && old.y != null) {
        n.x = old.x;
        n.y = old.y;
        n.vx = old.vx ?? 0;
        n.vy = old.vy ?? 0;
      }
    }
    nodesRef.current = built.nodes;
    linksRef.current = built.links;

    if (!simRef.current) {
      const sim = d3.forceSimulation<SimNode>(nodesRef.current)
        .velocityDecay(0.22)
        .alphaDecay(0.012)
        .force('charge', d3.forceManyBody<SimNode>().strength(-180))
        .force('x', d3.forceX<SimNode>(d => d.svc.cx).strength(0.06))
        .force('y', d3.forceY<SimNode>(d => d.svc.cy).strength(0.06))
        .force('collide', d3.forceCollide<SimNode>(d => d.size / 2 + 10))
        .force(
          'link',
          d3.forceLink<SimNode, SimLink>(linksRef.current)
            .id(d => d.id)
            .distance(l => l.cross ? 280 : 95)
            .strength(l => l.cross ? 0.02 : 0.30)
        )
        .alpha(1)
        .on('tick', () => {
          forceTick(t => (t + 1) % 1000000);
        });
      simRef.current = sim;
    } else {
      simRef.current.nodes(nodesRef.current);
      const linkForce = simRef.current.force('link') as d3.ForceLink<SimNode, SimLink>;
      linkForce.links(linksRef.current);
      const shapeChanged =
        nodesRef.current.length !== prev.size ||
        nodesRef.current.some(n => !prev.has(n.id));
      if (shapeChanged) {
        simRef.current.alpha(0.3).restart();
      } else {
        forceTick(t => (t + 1) % 1000000);
      }
    }
  }, [built]);

  useEffect(() => () => { simRef.current?.stop(); }, []);

  // d3-zoom: attach once on mount; filter out drag targets so they don't pan
  const zoomRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  useEffect(() => {
    if (!svgRef.current) return;
    const svg = d3.select(svgRef.current);
    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.15, 2.5])
      .filter(event => {
        const target = event.target as Element;
        if (target.closest('[data-node-id]')) return false;
        if (target.closest('[data-bubble-id]')) return false;
        return true;
      })
      .on('zoom', (event) => {
        const t = { x: event.transform.x, y: event.transform.y, k: event.transform.k };
        transformRef.current = t;
        setTransform(t);
      });
    svg.call(zoom as any);
    zoomRef.current = zoom;
  }, []);

  // Initial fit: only when the set of services changes (not on every data refetch)
  const fittedKey = useRef('');
  useEffect(() => {
    const key = built.services.map(s => s.name).sort().join(',');
    if (!key || key === fittedKey.current) return;
    if (!svgRef.current || !zoomRef.current) return;

    const doFit = () => {
      if (!svgRef.current || !zoomRef.current) return false;
      const rect = svgRef.current.getBoundingClientRect();
      if (rect.width < 50 || rect.height < 50) return false;
      const minX = Math.min(...built.services.map(s => s.cx - s.radius)) - 40;
      const maxX = Math.max(...built.services.map(s => s.cx + s.radius)) + 40;
      const w = maxX - minX;
      const k = Math.min(1, rect.width / w * 0.9);
      const x = rect.width / 2 - (minX + w / 2) * k;
      const y = rect.height / 2;
      const t = d3.zoomIdentity.translate(x, y).scale(k);
      d3.select(svgRef.current).call(zoomRef.current.transform as any, t);
      fittedKey.current = key;
      return true;
    };
    let attempts = 0;
    const tryFit = () => {
      if (doFit() || attempts++ > 5) return;
      requestAnimationFrame(tryFit);
    };
    requestAnimationFrame(tryFit);
  }, [built]);

  // ─── pointer helpers — read from transformRef so they're always current ───
  const screenToWorld = useCallback((clientX: number, clientY: number) => {
    if (!svgRef.current) return { x: 0, y: 0 };
    const pt = svgRef.current.createSVGPoint();
    pt.x = clientX; pt.y = clientY;
    const m = svgRef.current.getScreenCTM();
    if (!m) return { x: 0, y: 0 };
    const sp = pt.matrixTransform(m.inverse());
    const t = transformRef.current;
    return { x: (sp.x - t.x) / t.k, y: (sp.y - t.y) / t.k };
  }, []);

  // ─── Function node drag (window-level listeners so capture/bubbling doesn't matter) ───
  const onNodePointerDown = useCallback((e: React.PointerEvent, n: SimNode) => {
    e.preventDefault();
    e.stopPropagation();
    dragNodeRef.current = n;
    n.fx = n.x;
    n.fy = n.y;
    simRef.current?.alphaTarget(0.15).restart();

    const onMove = (ev: PointerEvent) => {
      if (!dragNodeRef.current) return;
      const w = screenToWorld(ev.clientX, ev.clientY);
      dragNodeRef.current.fx = w.x;
      dragNodeRef.current.fy = w.y;
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      if (dragNodeRef.current) {
        dragNodeRef.current.fx = null;
        dragNodeRef.current.fy = null;
        dragNodeRef.current = null;
        // Slow drift back: alpha kick decays gently — user lets go once,
        // node travels back to its bubble over several seconds.
        simRef.current?.alphaTarget(0).alpha(0.55).restart();
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }, [screenToWorld]);

  // ─── Bubble drag (moves the whole service + its nodes) ───
  const onBubblePointerDown = useCallback((e: React.PointerEvent, svc: ServiceInfo) => {
    e.preventDefault();
    e.stopPropagation();
    const w0 = screenToWorld(e.clientX, e.clientY);
    dragBubbleRef.current = {
      svc,
      startCx: svc.cx, startCy: svc.cy,
      startWX: w0.x, startWY: w0.y,
    };
    simRef.current?.alphaTarget(0.05).restart();

    const onMove = (ev: PointerEvent) => {
      if (!dragBubbleRef.current) return;
      const w = screenToWorld(ev.clientX, ev.clientY);
      const dx = w.x - dragBubbleRef.current.startWX;
      const dy = w.y - dragBubbleRef.current.startWY;
      const { svc: dragSvc, startCx, startCy } = dragBubbleRef.current;
      const newCx = startCx + dx;
      const newCy = startCy + dy;
      const shiftX = newCx - dragSvc.cx;
      const shiftY = newCy - dragSvc.cy;
      dragSvc.cx = newCx;
      dragSvc.cy = newCy;
      servicePosRef.current.set(dragSvc.name, { cx: newCx, cy: newCy });
      for (const n of nodesRef.current) {
        if (n.service === dragSvc.name) {
          if (n.x != null) n.x += shiftX;
          if (n.y != null) n.y += shiftY;
          if (n.fx != null) n.fx += shiftX;
          if (n.fy != null) n.fy += shiftY;
        }
      }
      forceTick(t => (t + 1) % 1000000);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      dragBubbleRef.current = null;
      simRef.current?.alphaTarget(0);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }, [screenToWorld]);

  // ─── render ───
  const isEmpty = datasets.length === 0 || datasets.every(d => !d.data?.nodes?.length);
  const { services, crossEdges, dbLinks } = built;
  const nodesById = new Map(nodesRef.current.map(n => [n.id, n]));
  const dbPosFor = (svc: ServiceInfo) => ({ x: svc.cx, y: svc.cy + svc.radius + 55 });

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <svg
        ref={svgRef}
        width="100%" height="100%"
        style={{ background: '#0d0e10', cursor: 'grab', display: 'block' }}
      >
        <defs>
          <marker id="arrow-cross" viewBox="0 -5 10 10" refX="10" refY="0" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M0,-5L10,0L0,5" fill={CROSS_EDGE_COLOR} />
          </marker>
          <marker id="arrow-intra" viewBox="0 -5 10 10" refX="10" refY="0" markerWidth="5" markerHeight="5" orient="auto">
            <path d="M0,-5L10,0L0,5" fill={EDGE_COLOR} />
          </marker>
        </defs>

        <g transform={`translate(${transform.x},${transform.y}) scale(${transform.k})`}>
          {/* Service bubbles — draggable */}
          {services.map(s => {
            const c = SERVICE_COLORS[s.idx % SERVICE_COLORS.length];
            return (
              <g key={`bubble-${s.name}`}>
                <circle
                  data-bubble-id={s.name}
                  cx={s.cx} cy={s.cy} r={s.radius}
                  fill={c.bg}
                  stroke={c.border}
                  strokeWidth={1.5}
                  style={{ cursor: 'grab' }}
                  onPointerDown={(e) => onBubblePointerDown(e, s)}
                />
                <text
                  x={s.cx} y={s.cy - s.radius - 14}
                  textAnchor="middle"
                  fontFamily="'Inter', sans-serif"
                  fontSize={12} fontWeight={600}
                  fill={c.label}
                  style={{ letterSpacing: '0.06em', textTransform: 'uppercase', pointerEvents: 'none' }}
                >
                  {s.name}
                </text>
              </g>
            );
          })}

          {/* DB barrels (follow their bubble) */}
          {services.map(s => {
            if (!dbLinks.some(d => d.service === s.name)) return null;
            const p = dbPosFor(s);
            return (
              <g key={`db-${s.name}`} transform={`translate(${p.x},${p.y})`} style={{ pointerEvents: 'none' }}>
                <rect x={-20} y={-14} width={40} height={28} rx={3} fill="#1a1d24" stroke="#2c2f35" strokeWidth={1} />
                <text x={0} y={4} textAnchor="middle" fontFamily="'Inter', sans-serif" fontSize={10} fontWeight={500} fill="#8e939c">DB</text>
              </g>
            );
          })}

          {/* Intra-service edges */}
          {linksRef.current.filter(l => !l.cross).map((l, i) => {
            const s = (typeof l.source === 'object' ? l.source : nodesById.get(l.source as string)) as SimNode | undefined;
            const t = (typeof l.target === 'object' ? l.target : nodesById.get(l.target as string)) as SimNode | undefined;
            if (!s || !t || s.x == null || t.x == null) return null;
            return (
              <line
                key={`l-${i}`}
                x1={s.x} y1={s.y} x2={t.x} y2={t.y}
                stroke={EDGE_COLOR}
                strokeWidth={1 + Math.min(1.5, l.weight / 50)}
                markerEnd="url(#arrow-intra)"
                opacity={0.85}
                style={{ pointerEvents: 'none' }}
              />
            );
          })}

          {/* DB connections */}
          {dbLinks.map((d, i) => {
            const src = nodesById.get(d.sourceNodeId);
            const svc = services.find(s => s.name === d.service);
            if (!src || !svc || src.x == null) return null;
            const dbP = dbPosFor(svc);
            return (
              <line
                key={`db-${i}`}
                x1={src.x} y1={src.y} x2={dbP.x} y2={dbP.y - 14}
                stroke={EDGE_COLOR} strokeWidth={1} strokeDasharray="4 3" opacity={0.7}
                style={{ pointerEvents: 'none' }}
              />
            );
          })}

          {/* Cross-service edges: straight line, function → function */}
          {crossEdges.map((c, i) => {
            const src = nodesById.get(c.sourceNodeId);
            const tgt = nodesById.get(c.targetNodeId);
            if (!src || !tgt || src.x == null || tgt.x == null || src.y == null || tgt.y == null) return null;
            return (
              <line
                key={`cx-${i}`}
                x1={src.x} y1={src.y} x2={tgt.x} y2={tgt.y}
                stroke={CROSS_EDGE_COLOR}
                strokeWidth={1.8}
                markerEnd="url(#arrow-cross)"
                style={{ pointerEvents: 'none' }}
              />
            );
          })}

          {/* Function nodes — rendered last so they're on top */}
          {nodesRef.current.map(n => (
            <g
              key={n.id}
              data-node-id={n.id}
              onPointerDown={(e) => onNodePointerDown(e, n)}
            >
              <FunctionNodeSVG
                node={n}
                selected={selectedId === n.id}
                errorThresholdPct={errorThresholdPct}
                onClick={() => {
                  if (dragNodeRef.current || dragBubbleRef.current) return;
                  setSelectedId(n.id);
                  onNodeClick(n.fn, n.service);
                }}
              />
            </g>
          ))}
        </g>
      </svg>

      {isEmpty && (
        <div
          className="empty-state"
          style={{
            position: 'absolute', inset: 0,
            display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center',
            pointerEvents: 'none', color: '#8e939c',
          }}
        >
          <div className="icon" style={{ fontSize: 32, marginBottom: 8 }}>&#x2B50;</div>
          <p>Select one or more services to view the execution map</p>
        </div>
      )}
    </div>
  );
};

export default ServiceGraph;
