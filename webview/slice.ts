/**
 * The outline where an axis-aligned plane cuts a triangle mesh, in the plane's own 2D coordinates,
 * plus snapping onto it. Pure functions: no Three.js, so they run in unit tests.
 */

export type AxisIndex = 0 | 1 | 2;

/** The two world axes that span the plane perpendicular to each axis: x → (y, z), y → (x, z), z → (x, y). */
export const PLANE_AXES: Record<AxisIndex, [AxisIndex, AxisIndex]> = { 0: [1, 2], 1: [0, 2], 2: [0, 1] };

export interface Circle {
  cu: number;
  cv: number;
  r: number;
}

/** A chain of outline points (u, v pairs). Closed loops have their first point not repeated at the end. */
export interface Loop {
  points: number[];
  closed: boolean;
  /** Present when the loop's points lie on a circle (a hole or round boss). */
  circle?: Circle;
}

export interface Slice {
  loops: Loop[];
}

export type SnapKind = 'vertex' | 'center' | 'edge';

export interface Snap {
  kind: SnapKind;
  u: number;
  v: number;
  loop: Loop;
}

/** Outline points closer than this (mm) are merged when tidying a loop. */
const JOIN_TOLERANCE = 1e-5;

/**
 * Cut every triangle with the plane `axis = offset` and join the pieces into loops.
 *
 * A plane passing exactly through mesh corners (e.g. z = 17.5 on a face at 17.5) gives broken
 * outlines: faces lying in the plane produce no pieces. Such planes are moved by 0.1 µm, far below
 * anything measurable, so they cut cleanly between corners.
 */
export function sliceMesh(positions: ArrayLike<number>, axis: AxisIndex, offset: number): Slice {
  let cut = offset;
  for (const nudge of [0, 1e-4, -1e-4, 2.7e-4]) {
    cut = offset + nudge;
    if (!touchesCorner(positions, axis, cut)) break;
  }
  return sliceAt(positions, axis, cut);
}

function touchesCorner(positions: ArrayLike<number>, axis: AxisIndex, cut: number): boolean {
  for (let i = axis; i < positions.length; i += 3) if (Math.abs(positions[i] - cut) < 1e-7) return true;
  return false;
}

/**
 * Each outline point comes from one mesh edge crossing the plane, and the two triangles that share
 * that edge produce the same point. So points are identified by their edge (its two corners' exact
 * coordinates), not by rounding their position: joining is exact, however close distinct points are.
 */
function sliceAt(positions: ArrayLike<number>, axis: AxisIndex, offset: number): Slice {
  const [ua, va] = PLANE_AXES[axis];
  const pointByEdge = new Map<string, number>();
  const coords: number[] = [];
  /** Pairs of point indices. */
  const segments: number[] = [];
  const corner = (p: number) => `${positions[p]},${positions[p + 1]},${positions[p + 2]}`;
  const ends: number[] = [];

  for (let t = 0; t + 8 < positions.length; t += 9) {
    const d = [positions[t + axis] - offset, positions[t + 3 + axis] - offset, positions[t + 6 + axis] - offset];
    // Treat points exactly on the plane as above it, so every crossing edge is counted once.
    const above = d.map((x) => x >= 0);
    if (above[0] === above[1] && above[1] === above[2]) continue;
    ends.length = 0;
    for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
      if (above[a] === above[b]) continue;
      // Name and interpolate every edge from its lower end, so both triangles agree exactly.
      const [i, j] = above[a] ? [b, a] : [a, b];
      const pi = t + i * 3;
      const pj = t + j * 3;
      const edge = `${corner(pi)}|${corner(pj)}`;
      let index = pointByEdge.get(edge);
      if (index === undefined) {
        const k = d[i] / (d[i] - d[j]);
        index = coords.length / 2;
        coords.push(positions[pi + ua] + k * (positions[pj + ua] - positions[pi + ua]));
        coords.push(positions[pi + va] + k * (positions[pj + va] - positions[pi + va]));
        pointByEdge.set(edge, index);
      }
      ends.push(index);
    }
    if (ends.length === 2 && ends[0] !== ends[1]) segments.push(ends[0], ends[1]);
  }
  return { loops: joinSegments(coords, segments).map(finishLoop) };
}

/** Chain segments (pairs of point indices) end to end into loops. */
function joinSegments(coords: number[], segments: number[]): Loop[] {
  const count = segments.length / 2;
  const byPoint = new Map<number, number[]>();
  for (let s = 0; s < count; s++) {
    for (const p of [segments[s * 2], segments[s * 2 + 1]]) {
      const list = byPoint.get(p);
      if (list) list.push(s);
      else byPoint.set(p, [s]);
    }
  }
  const used = new Uint8Array(count);

  /** Follow unused segments from point `p`; returns the points reached, not including `p`. */
  const walk = (p: number): number[] => {
    const out: number[] = [];
    for (;;) {
      const next = byPoint.get(p)?.find((s) => !used[s]);
      if (next === undefined) return out;
      used[next] = 1;
      p = segments[next * 2] === p ? segments[next * 2 + 1] : segments[next * 2];
      out.push(p);
    }
  };
  const toCoords = (indices: number[]) => indices.flatMap((i) => [coords[i * 2], coords[i * 2 + 1]]);

  const loops: Loop[] = [];
  for (let s = 0; s < count; s++) {
    if (used[s]) continue;
    used[s] = 1;
    const [start, second] = [segments[s * 2], segments[s * 2 + 1]];
    const ahead = walk(second);
    if (ahead.at(-1) === start) {
      loops.push({ points: toCoords([start, second, ...ahead.slice(0, -1)]), closed: true });
    } else {
      // An open chain (only on a damaged mesh): extend it backwards from the start too.
      const behind = walk(start).reverse();
      loops.push({ points: toCoords([...behind, start, second, ...ahead]), closed: false });
    }
  }
  return loops;
}

/** Drop points in the middle of straight runs (left by triangle edges), then detect circles. */
function finishLoop(loop: Loop): Loop {
  const p = loop.points;
  const n = p.length / 2;
  const kept: number[] = [];
  for (let i = 0; i < n; i++) {
    const isEnd = !loop.closed && (i === 0 || i === n - 1);
    const prev = (i - 1 + n) % n;
    const next = (i + 1) % n;
    const ax = p[i * 2] - p[prev * 2];
    const ay = p[i * 2 + 1] - p[prev * 2 + 1];
    const bx = p[next * 2] - p[i * 2];
    const by = p[next * 2 + 1] - p[i * 2 + 1];
    const la = Math.hypot(ax, ay);
    const lb = Math.hypot(bx, by);
    if (!isEnd && (la < JOIN_TOLERANCE || (Math.abs(ax * by - ay * bx) <= 1e-9 * la * lb && ax * bx + ay * by > 0))) continue;
    kept.push(p[i * 2], p[i * 2 + 1]);
  }
  const result: Loop = { points: kept, closed: loop.closed };
  const circle = loop.closed ? fitCircle(kept) : undefined;
  if (circle) result.circle = circle;
  return result;
}

/**
 * Least-squares circle through the points (Kåsa fit). Only returned when there are enough points and
 * every point is within 1% of the radius, i.e. the loop really is a faceted circle.
 */
export function fitCircle(points: number[]): Circle | undefined {
  const n = points.length / 2;
  if (n < 8) return undefined;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += points[i * 2];
    my += points[i * 2 + 1];
  }
  mx /= n;
  my /= n;
  // Solve for x² + y² + D·x + E·y + F = 0 around the centroid, for numerical stability.
  let sxx = 0, sxy = 0, syy = 0, sx = 0, sy = 0, sxz = 0, syz = 0, sz = 0;
  for (let i = 0; i < n; i++) {
    const x = points[i * 2] - mx;
    const y = points[i * 2 + 1] - my;
    const z = x * x + y * y;
    sxx += x * x;
    sxy += x * y;
    syy += y * y;
    sx += x;
    sy += y;
    sxz += x * z;
    syz += y * z;
    sz += z;
  }
  const solved = solve3(
    [
      [sxx, sxy, sx],
      [sxy, syy, sy],
      [sx, sy, n],
    ],
    [-sxz, -syz, -sz],
  );
  if (!solved) return undefined;
  const [D, E, F] = solved;
  const cx = -D / 2;
  const cy = -E / 2;
  const r2 = cx * cx + cy * cy - F;
  if (!(r2 > 0)) return undefined;
  const r = Math.sqrt(r2);
  for (let i = 0; i < n; i++) {
    const dist = Math.hypot(points[i * 2] - mx - cx, points[i * 2 + 1] - my - cy);
    if (Math.abs(dist - r) > r * 0.01) return undefined;
  }
  return { cu: cx + mx, cv: cy + my, r };
}

function solve3(m: number[][], b: number[]): [number, number, number] | undefined {
  const det = (a: number[][]) =>
    a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) -
    a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) +
    a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
  const d = det(m);
  if (Math.abs(d) < 1e-12) return undefined;
  const col = (c: number) => m.map((row, i) => row.map((v, j) => (j === c ? b[i] : v)));
  return [det(col(0)) / d, det(col(1)) / d, det(col(2)) / d];
}

/**
 * The feature nearest (u, v) within `radius`, preferring corners, then circle centres, then edges.
 * Undefined when nothing is close: the caller then uses the raw point.
 */
export function findSnap(slice: Slice, u: number, v: number, radius: number): Snap | undefined {
  let best: Snap | undefined;
  let bestDist = radius;
  const consider = (kind: SnapKind, su: number, sv: number, loop: Loop) => {
    const dist = Math.hypot(su - u, sv - v);
    if (dist <= bestDist) {
      best = { kind, u: su, v: sv, loop };
      bestDist = dist;
    }
  };

  for (const loop of slice.loops) {
    const p = loop.points;
    for (let i = 0; i < p.length; i += 2) consider('vertex', p[i], p[i + 1], loop);
  }
  if (best) return best;
  for (const loop of slice.loops) if (loop.circle) consider('center', loop.circle.cu, loop.circle.cv, loop);
  if (best) return best;
  forEachEdge(slice, (au, av, bu, bv, loop) => {
    const [qu, qv] = nearestOnSegment(u, v, au, av, bu, bv);
    consider('edge', qu, qv, loop);
  });
  return best;
}

/** Calls `fn` for every edge of every loop, with the edge's two end points. */
function forEachEdge(slice: Slice, fn: (au: number, av: number, bu: number, bv: number, loop: Loop) => void): void {
  for (const loop of slice.loops) {
    const p = loop.points;
    const n = p.length / 2;
    const edges = loop.closed ? n : n - 1;
    for (let i = 0; i < edges; i++) {
      const j = (i + 1) % n;
      fn(p[i * 2], p[i * 2 + 1], p[j * 2], p[j * 2 + 1], loop);
    }
  }
}

/** Even-odd rule over one closed loop. */
function loopContains(loop: Loop, u: number, v: number): boolean {
  const p = loop.points;
  const n = p.length / 2;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [ui, vi, uj, vj] = [p[i * 2], p[i * 2 + 1], p[j * 2], p[j * 2 + 1]];
    if (vi > v !== vj > v && u < ((uj - ui) * (v - vi)) / (vj - vi) + ui) inside = !inside;
  }
  return inside;
}

/** Inside the material: inside an odd number of closed loops (an outline minus its holes). */
export function insideSlice(slice: Slice, u: number, v: number): boolean {
  let inside = false;
  for (const loop of slice.loops) if (loop.closed && loopContains(loop, u, v)) inside = !inside;
  return inside;
}

function loopArea(loop: Loop): number {
  const p = loop.points;
  const n = p.length / 2;
  let twice = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) twice += p[j * 2] * p[i * 2 + 1] - p[i * 2] * p[j * 2 + 1];
  return Math.abs(twice) / 2;
}

/** The smallest closed loop around (u, v), e.g. the hole it is in; undefined outside every loop. */
export function loopAround(slice: Slice, u: number, v: number): Loop | undefined {
  let best: Loop | undefined;
  let bestArea = Infinity;
  for (const loop of slice.loops) {
    if (!loop.closed || !loopContains(loop, u, v)) continue;
    const area = loopArea(loop);
    if (area < bestArea) {
      best = loop;
      bestArea = area;
    }
  }
  return best;
}

export interface Bounds2 {
  minU: number;
  minV: number;
  maxU: number;
  maxV: number;
}

export function pointsBounds(points: number[]): Bounds2 {
  const b = { minU: Infinity, minV: Infinity, maxU: -Infinity, maxV: -Infinity };
  for (let i = 0; i < points.length; i += 2) {
    b.minU = Math.min(b.minU, points[i]);
    b.maxU = Math.max(b.maxU, points[i]);
    b.minV = Math.min(b.minV, points[i + 1]);
    b.maxV = Math.max(b.maxV, points[i + 1]);
  }
  return b;
}

/** Distance along the ray from (u, v) in direction (du, dv) to the first outline edge beyond `minT`. */
export function castRay2d(slice: Slice, u: number, v: number, du: number, dv: number, minT = 1e-6): number | undefined {
  let best: number | undefined;
  forEachEdge(slice, (au, av, bu, bv) => {
    const eu = bu - au;
    const ev = bv - av;
    const denom = du * ev - dv * eu;
    if (Math.abs(denom) < 1e-12) return; // parallel
    const t = ((au - u) * ev - (av - v) * eu) / denom;
    const s = ((au - u) * dv - (av - v) * du) / denom;
    if (t > minT && s >= 0 && s <= 1 && (best === undefined || t < best)) best = t;
  });
  return best;
}

export interface Wall {
  from: [number, number];
  to: [number, number];
}

/**
 * Wall thickness at the outline edge nearest (u, v), within `radius`: from that edge straight across
 * the material to the next outline edge. "Straight across" is perpendicular to the edge, or along the
 * radius on a round outline, whose facets would otherwise tilt it.
 */
export function wallAcross(slice: Slice, u: number, v: number, radius: number): Wall | undefined {
  let edge: { u: number; v: number; nu: number; nv: number } | undefined;
  let bestDist = radius;
  forEachEdge(slice, (au, av, bu, bv, loop) => {
    const [qu, qv] = nearestOnSegment(u, v, au, av, bu, bv);
    const dist = Math.hypot(qu - u, qv - v);
    const len = Math.hypot(bu - au, bv - av);
    if (dist > bestDist || len === 0) return;
    bestDist = dist;
    const c = loop.circle;
    const r = c && Math.hypot(qu - c.cu, qv - c.cv);
    edge = c && r ? { u: qu, v: qv, nu: (qu - c.cu) / r, nv: (qv - c.cv) / r } : { u: qu, v: qv, nu: -(bv - av) / len, nv: (bu - au) / len };
  });
  if (!edge) return undefined;
  // Try both directions; the material is on the side whose span is inside the cut.
  for (const sign of [1, -1]) {
    const nu = edge.nu * sign;
    const nv = edge.nv * sign;
    const t = castRay2d(slice, edge.u, edge.v, nu, nv);
    if (t === undefined) continue;
    if (insideSlice(slice, edge.u + (nu * t) / 2, edge.v + (nv * t) / 2)) {
      return { from: [edge.u, edge.v], to: [edge.u + nu * t, edge.v + nv * t] };
    }
  }
  return undefined;
}

function nearestOnSegment(u: number, v: number, au: number, av: number, bu: number, bv: number): [number, number] {
  const du = bu - au;
  const dv = bv - av;
  const len2 = du * du + dv * dv;
  const t = len2 > 0 ? Math.min(1, Math.max(0, ((u - au) * du + (v - av) * dv) / len2)) : 0;
  return [au + t * du, av + t * dv];
}
