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
const CROSS_EDGE_FAINT = 'rgba(255, 152, 48, 0.30)';

// ─────────────────────────────────────────────────────────────────────────────
// Types

type SimNode = d3.SimulationNodeDatum & {
  id: string;
  fn: string;
  service: string;
  serviceIdx: number;
  stats: NodeStats;
  isEntry: boolean;
  size: number;
  homeX: number;
  homeY: number;
  homeRadius: number;
};

type SimLink = d3.SimulationLinkDatum<SimNode> & {
  weight: number;
};

type ServiceInfo = {
  name: string;
  idx: number;
  cx: number;
  cy: number;
  radius: number;
  entryNodeId?: string;
};

type CrossEdge = {
  sourceNodeId: string;
  targetService: string;
};

type DBLink = {
  sourceNodeId: string;
  service: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// Build sim inputs from API datasets

function build(
  datasets: { service: string; data: ExecutionMapResponse }[]
) {
  const nodes: SimNode[] = [];
  const links: SimLink[] = [];
  const services: ServiceInfo[] = [];
  const crossEdges: CrossEdge[] = [];
  const dbLinks: DBLink[] = [];

  const BUBBLE_GAP = 720;
  const allServices = datasets.map(d => d.service);

  // Port→service mapping (test services use 8081/8082/8083 by index)
  const portToService: Record<string, string> = {};
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

    const cx = svcIdx * BUBBLE_GAP;
    const cy = 0;
    const nodeCount = data.nodes.length;
    const radius = Math.max(190, Math.sqrt(nodeCount) * 60);

    // Compute entry points: nodes that are not a child of any other in this service
    const isChild: Record<string, boolean> = {};
    for (const e of (data.edges || [])) isChild[e.to] = true;
    const entryFn = data.nodes.find(n => n.is_entry_point || !isChild[n.function])?.function;

    services.push({
      name: service,
      idx: svcIdx,
      cx, cy,
      radius,
      entryNodeId: entryFn ? `${service}::${entryFn}` : undefined,
    });

    // Function nodes
    for (const n of data.nodes) {
      const id = `${service}::${n.function}`;
      const isEntry = n.is_entry_point || n.function === entryFn;
      const size = isEntry ? 72 : 52;

      // Initialize on a small ring around center so the sim doesn't start collapsed
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
        homeX: cx,
        homeY: cy,
        homeRadius: radius,
        x: cx + Math.cos(a) * r,
        y: cy + Math.sin(a) * r,
      });

      // External calls → DB or cross-service
      for (const ec of (n.external_calls || [])) {
        const low = ec.toLowerCase();
        if (low === 'database' || low.includes('db')) {
          dbLinks.push({ sourceNodeId: id, service });
        } else {
          const m = ec.match(/:(\d{4})/);
          const tgtSvc = m && portToService[m[1]];
          if (tgtSvc && tgtSvc !== service) {
            crossEdges.push({ sourceNodeId: id, targetService: tgtSvc });
          }
        }
      }
    }

    // Intra-service links
    for (const e of (data.edges || [])) {
      links.push({
        source: `${service}::${e.from}`,
        target: `${service}::${e.to}`,
        weight: e.count,
      });
    }
  });

  // Dedupe cross-edges by source→target service
  const seen = new Set<string>();
  const uniqueCross = crossEdges.filter(c => {
    const k = `${c.sourceNodeId}->${c.targetService}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

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
// Geometry helpers

function perimeterPoint(svc: ServiceInfo, towardX: number, towardY: number, inset = 0) {
  const dx = towardX - svc.cx;
  const dy = towardY - svc.cy;
  const d = Math.sqrt(dx * dx + dy * dy) || 1;
  const r = svc.radius - inset;
  return { x: svc.cx + dx * r / d, y: svc.cy + dy * r / d };
}

// ─────────────────────────────────────────────────────────────────────────────
// Function node SVG (replaces the React Flow node)

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
  const errorPct = stats.error_count / total;
  const successPct = 1 - errorPct;
  const hasError = stats.error_count > 0;
  const overThreshold = errorPct * 100 >= errorThresholdPct;

  const circumference = 2 * Math.PI * innerR;
  const successLen = circumference * successPct;
  const errorLen = circumference * errorPct;

  const red = '#F2495C';
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
        strokeDasharray={`${successLen} ${circumference}`}
        transform={`rotate(-90)`}
        opacity={0.9}
      />
      {hasError && (
        <circle
          cx={0} cy={0} r={innerR}
          fill="none"
          stroke={overThreshold ? red : 'rgba(242,73,92,0.6)'}
          strokeWidth={strokeW}
          strokeDasharray={`${errorLen} ${circumference}`}
          strokeDashoffset={-successLen}
          transform={`rotate(-90)`}
        />
      )}
      {selected && (
        <circle cx={0} cy={0} r={r} fill="none" stroke="#fff" strokeWidth={1.5} opacity={0.45} />
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
  const [transform, setTransform] = useState({ x: 0, y: 0, k: 1 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [, forceTick] = useState(0);

  const built = useMemo(() => build(datasets), [datasets]);

  // Cache nodes/links objects in refs so we can mutate them in place via d3
  const nodesRef = useRef<SimNode[]>([]);
  const linksRef = useRef<SimLink[]>([]);

  useEffect(() => {
    // Preserve positions across data refetches: carry x/y/vx/vy by node ID
    const prev = new Map(nodesRef.current.map(n => [n.id, n]));
    for (const n of built.nodes) {
      const old = prev.get(n.id);
      if (old && old.x != null && old.y != null) {
        n.x = old.x;
        n.y = old.y;
        n.vx = old.vx ?? 0;
        n.vy = old.vy ?? 0;
        // Update home position if service layout shifted, but keep current x/y
        // so the node drifts to its new home naturally via forceX/Y
      }
    }
    nodesRef.current = built.nodes;
    linksRef.current = built.links;

    if (!simRef.current) {
      // First mount: create simulation
      const sim = d3.forceSimulation<SimNode>(nodesRef.current)
        .force('charge', d3.forceManyBody().strength(-220))
        .force('x', d3.forceX<SimNode>(d => d.homeX).strength(0.10))
        .force('y', d3.forceY<SimNode>(d => d.homeY).strength(0.10))
        .force('collide', d3.forceCollide<SimNode>(d => d.size / 2 + 12))
        .force(
          'link',
          d3.forceLink<SimNode, SimLink>(linksRef.current)
            .id(d => d.id)
            .distance(110)
            .strength(0.35)
        )
        .alpha(1)
        .alphaDecay(0.025)
        .on('tick', () => {
          // Clamp inside bubble radius
          for (const n of nodesRef.current) {
            const dx = (n.x ?? 0) - n.homeX;
            const dy = (n.y ?? 0) - n.homeY;
            const dist = Math.sqrt(dx * dx + dy * dy) || 0.0001;
            const maxR = n.homeRadius - n.size / 2 - 12;
            if (dist > maxR) {
              n.x = n.homeX + dx * maxR / dist;
              n.y = n.homeY + dy * maxR / dist;
            }
          }
          forceTick(t => (t + 1) % 1000000);
        });
      simRef.current = sim;
    } else {
      // Subsequent refetches: update sim in place; do NOT restart hard
      simRef.current.nodes(nodesRef.current);
      const linkForce = simRef.current.force('link') as d3.ForceLink<SimNode, SimLink>;
      linkForce.links(linksRef.current);
      // Gentle re-heat only if the shape changed (new/removed nodes)
      const shapeChanged =
        nodesRef.current.length !== prev.size ||
        nodesRef.current.some(n => !prev.has(n.id));
      if (shapeChanged) {
        simRef.current.alpha(0.3).restart();
      } else {
        // Shape unchanged: sim won't tick on its own — force one render so
        // updated stats (latency/calls/errors) appear without resetting positions.
        forceTick(t => (t + 1) % 1000000);
      }
    }
  }, [built]);

  // Stop simulation on unmount
  useEffect(() => () => { simRef.current?.stop(); }, []);

  // d3-zoom: attach ONCE on mount (re-attaching would leak listeners & reset transforms)
  const zoomRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  useEffect(() => {
    if (!svgRef.current) return;
    const svg = d3.select(svgRef.current);
    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.15, 2.5])
      .filter(event => {
        // Don't zoom-pan when starting on a function node (we drag those)
        const target = event.target as Element;
        return !target.closest('[data-node-id]');
      })
      .on('zoom', (event) => {
        setTransform({ x: event.transform.x, y: event.transform.y, k: event.transform.k });
      });
    svg.call(zoom as any);
    zoomRef.current = zoom;
  }, []);

  // Initial fit: ONLY when the set of services changes (not on every data refetch)
  const fittedKey = useRef('');
  useEffect(() => {
    const key = built.services.map(s => s.name).sort().join(',');
    if (!key || key === fittedKey.current) return;
    if (!svgRef.current || !zoomRef.current) return;

    const doFit = () => {
      if (!svgRef.current || !zoomRef.current) return false;
      const rect = svgRef.current.getBoundingClientRect();
      // SVG might still be 0×0 on the same frame it mounts — wait for layout
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

    // Defer one frame so the SVG has its real dimensions; retry up to 5 frames.
    let attempts = 0;
    const tryFit = () => {
      if (doFit() || attempts++ > 5) return;
      requestAnimationFrame(tryFit);
    };
    requestAnimationFrame(tryFit);
  }, [built]);


  // Drag handler for function nodes
  const onNodePointerDown = useCallback((e: React.PointerEvent, n: SimNode) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    dragNodeRef.current = n;
    n.fx = n.x;
    n.fy = n.y;
    simRef.current?.alphaTarget(0.3).restart();
  }, []);

  const onNodePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragNodeRef.current || !svgRef.current) return;
    const pt = svgRef.current.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const screenCTM = svgRef.current.getScreenCTM();
    if (!screenCTM) return;
    const svgPt = pt.matrixTransform(screenCTM.inverse());
    // Account for zoom transform
    const wx = (svgPt.x - transform.x) / transform.k;
    const wy = (svgPt.y - transform.y) / transform.k;
    dragNodeRef.current.fx = wx;
    dragNodeRef.current.fy = wy;
  }, [transform]);

  const onNodePointerUp = useCallback((e: React.PointerEvent) => {
    if (!dragNodeRef.current) return;
    dragNodeRef.current.fx = null;
    dragNodeRef.current.fy = null;
    dragNodeRef.current = null;
    // Give the sim a brief kick so the released node drifts back to its bubble
    simRef.current?.alphaTarget(0).alpha(0.5).restart();
  }, []);

  // ─── render ───
  const isEmpty = datasets.length === 0 || datasets.every(d => !d.data?.nodes?.length);

  const { services, crossEdges, dbLinks } = built;
  const nodesById = new Map(nodesRef.current.map(n => [n.id, n]));

  // DB barrel positions: directly below each service bubble
  const dbPosFor = (svc: ServiceInfo) => ({ x: svc.cx, y: svc.cy + svc.radius + 55 });

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
    <svg
      ref={svgRef}
      width="100%" height="100%"
      style={{ background: '#0d0e10', cursor: 'grab', display: 'block' }}
      onPointerMove={onNodePointerMove}
      onPointerUp={onNodePointerUp}
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
        {/* Service bubbles */}
        {services.map(s => {
          const c = SERVICE_COLORS[s.idx % SERVICE_COLORS.length];
          return (
            <g key={`bubble-${s.name}`}>
              <circle
                cx={s.cx} cy={s.cy} r={s.radius}
                fill={c.bg}
                stroke={c.border}
                strokeWidth={1.5}
              />
              <text
                x={s.cx} y={s.cy - s.radius - 14}
                textAnchor="middle"
                fontFamily="'Inter', sans-serif"
                fontSize={12}
                fontWeight={600}
                fill={c.label}
                style={{ letterSpacing: '0.06em', textTransform: 'uppercase' }}
              >
                {s.name}
              </text>
            </g>
          );
        })}

        {/* DB barrels */}
        {services.map(s => {
          if (!dbLinks.some(d => d.service === s.name)) return null;
          const p = dbPosFor(s);
          return (
            <g key={`db-${s.name}`} transform={`translate(${p.x},${p.y})`}>
              <rect
                x={-20} y={-14} width={40} height={28} rx={3}
                fill="#1a1d24" stroke="#2c2f35" strokeWidth={1}
              />
              <text x={0} y={4} textAnchor="middle" fontFamily="'Inter', sans-serif" fontSize={10} fontWeight={500} fill="#8e939c">DB</text>
            </g>
          );
        })}

        {/* Intra-service edges */}
        {linksRef.current.map((l, i) => {
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
            />
          );
        })}

        {/* DB connections */}
        {dbLinks.map((d, i) => {
          const src = nodesById.get(d.sourceNodeId);
          const svc = services.find(s => s.name === d.service);
          if (!src || !svc || src.x == null) return null;
          const dbP = dbPosFor(svc);
          // Exit at bubble perimeter toward DB, then line continues to DB
          const exit = perimeterPoint(svc, dbP.x, dbP.y, 2);
          return (
            <g key={`db-${i}`}>
              <line
                x1={src.x} y1={src.y} x2={exit.x} y2={exit.y}
                stroke={EDGE_COLOR} strokeWidth={1} strokeDasharray="4 3" opacity={0.6}
              />
              <line
                x1={exit.x} y1={exit.y} x2={dbP.x} y2={dbP.y - 14}
                stroke={EDGE_COLOR} strokeWidth={1} strokeDasharray="4 3"
              />
            </g>
          );
        })}

        {/* Cross-service edges: anchor at bubble perimeters */}
        {crossEdges.map((c, i) => {
          const src = nodesById.get(c.sourceNodeId);
          const srcSvc = services.find(s => s.name === src?.service);
          const tgtSvc = services.find(s => s.name === c.targetService);
          if (!src || !srcSvc || !tgtSvc || src.x == null) return null;

          // Perimeter anchors along center-to-center line
          const srcAnchor = perimeterPoint(srcSvc, tgtSvc.cx, tgtSvc.cy, 0);
          const tgtAnchor = perimeterPoint(tgtSvc, srcSvc.cx, srcSvc.cy, 0);

          // Entry node in target service
          const tgtEntry = tgtSvc.entryNodeId ? nodesById.get(tgtSvc.entryNodeId) : undefined;
          const tgtX = tgtEntry?.x ?? tgtSvc.cx;
          const tgtY = tgtEntry?.y ?? tgtSvc.cy;

          // Curved path between perimeter anchors
          const mx = (srcAnchor.x + tgtAnchor.x) / 2;
          const my = (srcAnchor.y + tgtAnchor.y) / 2 - Math.abs(tgtAnchor.x - srcAnchor.x) * 0.12;

          return (
            <g key={`cx-${i}`}>
              {/* Source fn → src perimeter anchor (faint, inside bubble) */}
              <line
                x1={src.x} y1={src.y} x2={srcAnchor.x} y2={srcAnchor.y}
                stroke={CROSS_EDGE_FAINT} strokeWidth={1} strokeDasharray="4 3"
              />
              {/* Perimeter dots */}
              <circle cx={srcAnchor.x} cy={srcAnchor.y} r={3.5} fill={CROSS_EDGE_COLOR} />
              <circle cx={tgtAnchor.x} cy={tgtAnchor.y} r={3.5} fill={CROSS_EDGE_COLOR} />
              {/* Curve between perimeters */}
              <path
                d={`M${srcAnchor.x},${srcAnchor.y} Q${mx},${my} ${tgtAnchor.x},${tgtAnchor.y}`}
                fill="none"
                stroke={CROSS_EDGE_COLOR}
                strokeWidth={1.6}
                markerEnd="url(#arrow-cross)"
              />
              {/* Target perimeter anchor → target entry (faint, inside bubble) */}
              <line
                x1={tgtAnchor.x} y1={tgtAnchor.y} x2={tgtX} y2={tgtY}
                stroke={CROSS_EDGE_FAINT} strokeWidth={1} strokeDasharray="4 3"
              />
            </g>
          );
        })}

        {/* Function nodes (rendered last, so they're on top) */}
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
                if (dragNodeRef.current) return; // ignore click if we were dragging
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
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          pointerEvents: 'none',
          color: '#8e939c',
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
