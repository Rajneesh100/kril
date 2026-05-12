---
name: kril graph viz approach
description: For service-graph visualization, user validated the hybrid d3-force-per-service layout over pure force-directed or pure hierarchical
type: feedback
---

For visualizing service/function call graphs in kril, the working approach is **hybrid d3-force per service**:
- Service bubbles are at fixed positions (row layout, cx = idx * GAP)
- Each service runs its own force simulation inside its bubble (forceX/Y → home center, forceCollide, forceLink for parent→child)
- Hard radial clamp on every tick keeps nodes inside their bubble
- Inter-service edges anchor at bubble perimeters (curved bezier between perimeter dots)
- DB barrels hang outside each bubble at fixed position
- All function nodes within a service share that service's color

**Why:** User explicitly rejected pure d3 disjoint-force-directed (loses service grouping → blob) and the existing react-flow auto-layout (messy edge crossings). The hybrid keeps the spatial "service identity" intact while letting forces handle within-service layout. They confirmed "now it's good" after the implementation.

**How to apply:** If future work touches the graph in [ServiceGraph.tsx](ui/src/components/ServiceGraph.tsx), preserve this architecture. Don't suggest collapsing all nodes into a single global simulation or switching to a different graph library without strong reason. Tunables they may adjust: BUBBLE_GAP (720), forceManyBody strength (-220), forceX/Y strength (0.10).

Two non-obvious gotchas already fixed (worth keeping in mind for similar React+d3 work):
1. Carry node positions across data refetches by ID, and only re-heat the simulation when shape changes — otherwise polling resets every drag.
2. SVG must be in the initial render (not gated behind an empty-state early return) so refs are populated before useEffect runs.
