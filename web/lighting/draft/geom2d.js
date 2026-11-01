/* WEA Drafting — 2D plan geometry, object snaps, tracking, temporary dimensions, layout helpers.
 * Pure functions on plan coordinates (IFC local X/Y, metres); no DOM, no three.js (unit-tested).
 * Snap behaviour follows the usual CAD conventions (AutoCAD OSNAP / OTRACK / ORTHO, Archicad
 * guide lines): explicit object points first, then alignment tracking, then the module grid.
 * Segments: { a:[x,y], b:[x,y], kind:'wall'|'other'|'ceiling'|'room'|'axis', label?, el? }.
 */
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
export const mul = (a, k) => [a[0] * k, a[1] * k];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
export const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function closestOnSegment(p, a, b) {
  const d = sub(b, a), L2 = dot(d, d);
  const t = L2 > 0 ? Math.max(0, Math.min(1, dot(sub(p, a), d) / L2)) : 0;
  const q = add(a, mul(d, t));
  return { point: q, t, d: dist(p, q) };
}

/** Intersection point of segments ab and cd (endpoints included), or null (parallel / disjoint). */
export function segmentIntersection(a, b, c, d, eps = 1e-9) {
  const r = sub(b, a), s = sub(d, c), den = cross(r, s);
  if (Math.abs(den) < eps * Math.max(1, Math.hypot(...r) * Math.hypot(...s))) return null;
  const qp = sub(c, a), t = cross(qp, s) / den, u = cross(qp, r) / den;
  const e = 1e-7;
  if (t < -e || t > 1 + e || u < -e || u > 1 + e) return null;
  return add(a, mul(r, t));
}

/** Intersection of the infinite lines through ab and cd, or null if parallel. */
export function lineIntersection(a, b, c, d) {
  const r = sub(b, a), s = sub(d, c), den = cross(r, s);
  if (Math.abs(den) < 1e-12) return null;
  return add(a, mul(r, cross(sub(c, a), s) / den));
}

/** Distance t ≥ 0 along the unit ray p + t·dir to segment ab, or null. */
export function rayDistance(p, dir, a, b) {
  const s = sub(b, a), den = cross(dir, s);
  if (Math.abs(den) < 1e-12) return null;                        // parallel: no crossing (collinear walls are not "in front")
  const qp = sub(a, p), t = cross(qp, s) / den, u = cross(qp, dir) / den;
  return t >= 1e-6 && u >= -1e-9 && u <= 1 + 1e-9 ? t : null;
}

/** Merge collinear, overlapping / touching segments (plan cuts produce one piece per triangle).
 *  Segments shorter than minLength after merging are dropped. Kind priority keeps the strongest kind. */
const KIND_RANK = { wall: 0, ceiling: 1, room: 2, other: 3, axis: 4 };
export function mergeSegments(segs, { angTol = 2e-3, offTol = 2e-3, gapTol = 2e-3, minLength = 0.01 } = {}) {
  const groups = new Map();
  for (const s of segs) {
    let d = sub(s.b, s.a); const L = Math.hypot(...d); if (L < 1e-6) continue;
    d = mul(d, 1 / L);
    if (d[0] < -1e-12 || (Math.abs(d[0]) <= 1e-12 && d[1] < 0)) d = mul(d, -1);   // canonical direction
    const ang = Math.atan2(d[1], d[0]), n = [-d[1], d[0]], off = dot(n, s.a);
    const key = `${s.kind}|${Math.round(ang / angTol)}|${Math.round(off / offTol)}`;
    let g = groups.get(key); if (!g) groups.set(key, g = { d, n, off, kind: s.kind, items: [] });
    const t0 = dot(d, s.a), t1 = dot(d, s.b);
    g.items.push([Math.min(t0, t1), Math.max(t0, t1), s]);
  }
  const out = [];
  for (const g of groups.values()) {
    g.items.sort((x, y) => x[0] - y[0]);
    let cur = null;
    const flush = () => {
      if (!cur || cur[1] - cur[0] < minLength) return;
      const base = mul(g.n, g.off);
      out.push({ a: add(base, mul(g.d, cur[0])), b: add(base, mul(g.d, cur[1])), kind: g.kind, label: cur[2].label, el: cur[2].el });
    };
    for (const it of g.items) {
      if (cur && it[0] <= cur[1] + gapTol) cur[1] = Math.max(cur[1], it[1]);
      else { flush(); cur = [...it]; }
    }
    flush();
  }
  return out.sort((x, y) => (KIND_RANK[x.kind] ?? 9) - (KIND_RANK[y.kind] ?? 9));
}

/** Uniform-grid spatial index over segments. */
export class SegmentIndex {
  constructor(segs, cell = 1) {
    this.segs = segs; this.cell = cell; this.map = new Map();
    segs.forEach((s, i) => {
      const [x0, x1] = [Math.min(s.a[0], s.b[0]), Math.max(s.a[0], s.b[0])], [y0, y1] = [Math.min(s.a[1], s.b[1]), Math.max(s.a[1], s.b[1])];
      for (let x = Math.floor(x0 / cell); x <= Math.floor(x1 / cell); x++)
        for (let y = Math.floor(y0 / cell); y <= Math.floor(y1 / cell); y++) {
          const k = x + ',' + y; (this.map.get(k) || this.map.set(k, []).get(k)).push(i);
        }
    });
  }
  /** segments whose distance to p is ≤ r */
  query(p, r, filter = null) {
    const c = this.cell, seen = new Set(), out = [];
    for (let x = Math.floor((p[0] - r) / c); x <= Math.floor((p[0] + r) / c); x++)
      for (let y = Math.floor((p[1] - r) / c); y <= Math.floor((p[1] + r) / c); y++)
        for (const i of this.map.get(x + ',' + y) || []) {
          if (seen.has(i)) continue; seen.add(i);
          const s = this.segs[i];
          if ((!filter || filter(s)) && closestOnSegment(p, s.a, s.b).d <= r) out.push(s);
        }
    return out;
  }
}

export const SNAP_LABELS = { end: '端点', mid: '中点', int: '交点', perp: '垂足', near: '最近点', fixture: '灯具中心', origin: '定位原点',
  center: '中心', track: '对齐追踪', track2: '对齐追踪', trackx: '对齐 ∩ 边线', grid: '模数网格', ortho: '正交', free: '' };
const PRIORITY = { end: 0, int: 0, fixture: 0, origin: 0, center: 0.5, mid: 1, perp: 1.5, near: 4 };

/**
 * Snap a cursor point.
 *   ctx: { index: SegmentIndex, points: [{ p, kind, label }], tracks: [{ p, label }], base: [x,y]|null, origin: [x,y] }
 *   opt: { tol (m), modes: { end, mid, int, perp, near, fixture, track, grid }, step (m), ortho: bool }
 * Returns { point, kind, label, guides: [[a,b], ...], ref }.
 */
export function snapPoint(p, ctx, opt) {
  const { tol, modes = {} } = opt, base = ctx.base;
  const segs = ctx.index ? ctx.index.query(p, tol, s => modes[s.kind === 'axis' ? 'axis' : 'geom'] !== false) : [];
  const cands = [];
  const consider = (q, kind, label, ref) => { const d = dist(p, q); if (d <= tol) cands.push({ point: q, kind, label, ref, score: d + PRIORITY[kind] * tol * 0.25 }); };
  for (const s of segs) {
    if (modes.end !== false) { consider(s.a, 'end', null, s); consider(s.b, 'end', null, s); }
    if (modes.mid !== false) consider(mul(add(s.a, s.b), 0.5), 'mid', null, s);
    if (modes.perp !== false && base) { const f = closestOnSegment(base, s.a, s.b); if (f.t > 0 && f.t < 1) consider(f.point, 'perp', null, s); }
  }
  if (modes.int !== false)
    for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
      const q = segmentIntersection(segs[i].a, segs[i].b, segs[j].a, segs[j].b); if (q) consider(q, 'int', null, [segs[i], segs[j]]);
    }
  for (const pt of ctx.points || []) if (modes[pt.kind === 'fixture' ? 'fixture' : 'end'] !== false) consider(pt.p, pt.kind, pt.label, pt);
  if (ctx.origin) consider(ctx.origin, 'origin', null, null);
  let best = cands.sort((x, y) => x.score - y.score)[0] || null;
  if (best) return { point: best.point, kind: best.kind, label: best.label || SNAP_LABELS[best.kind], guides: [], ref: best.ref };

  // alignment tracking with fixtures / base point (horizontal & vertical guide lines)
  let q = [...p], kind = 'free', guides = [];
  if (modes.track !== false && ctx.tracks?.length) {
    let tx = null, ty = null;
    for (const t of ctx.tracks) {
      const dx = Math.abs(p[0] - t.p[0]), dy = Math.abs(p[1] - t.p[1]);
      if (dx <= tol && (!tx || dx < tx.d)) tx = { d: dx, t };
      if (dy <= tol && (!ty || dy < ty.d)) ty = { d: dy, t };
    }
    if (tx && ty && tx.t !== ty.t) { q = [tx.t.p[0], ty.t.p[1]]; kind = 'track2'; guides = [[tx.t.p, q], [ty.t.p, q]]; }
    else if (tx || ty) {
      const t = (tx || ty).t, vertical = !!tx && (!ty || tx.d <= ty.d);
      q = vertical ? [t.p[0], p[1]] : [p[0], t.p[1]]; kind = 'track';
      // the guide crossing a nearby edge snaps to that crossing
      const near = ctx.index ? ctx.index.query(q, tol, s => modes.geom !== false && s.kind !== 'axis') : [];
      const far = vertical ? [t.p[0], t.p[1] + 1] : [t.p[0] + 1, t.p[1]];
      let hit = null;
      for (const s of near) { const x = lineIntersection(t.p, far, s.a, s.b); if (x && closestOnSegment(x, s.a, s.b).d < 1e-6 && dist(x, q) <= tol && (!hit || dist(x, q) < dist(hit, q))) hit = x; }
      if (hit) { q = hit; kind = 'trackx'; }
      else if (modes.grid !== false && opt.step > 0) {           // the free coordinate still follows the module grid
        const o = ctx.origin || [0, 0], k = vertical ? 1 : 0;
        q[k] = roundTo(q[k], opt.step, o[k]);
      }
      guides = [[t.p, q]];
    }
  }
  if (kind === 'free' && modes.grid !== false && opt.step > 0) {
    const o = ctx.origin || [0, 0];
    q = [roundTo(p[0], opt.step, o[0]), roundTo(p[1], opt.step, o[1])]; kind = 'grid';
  }
  // ORTHO: constrain to the horizontal / vertical through the base point
  if (base && opt.ortho && kind !== 'track2') {
    const horiz = Math.abs(q[0] - base[0]) >= Math.abs(q[1] - base[1]);
    q = horiz ? [q[0], base[1]] : [base[0], q[1]]; kind = kind === 'free' ? 'ortho' : kind;
    guides.push([base, q]);
  }
  if (kind === 'free' && modes.near !== false && segs.length) {      // nothing else: stick to the nearest edge
    const c = segs.map(s => ({ s, ...closestOnSegment(p, s.a, s.b) })).sort((x, y) => x.d - y.d)[0];
    if (c) return { point: c.point, kind: 'near', label: SNAP_LABELS.near, guides: [], ref: c.s };
  }
  return { point: q, kind, label: SNAP_LABELS[kind], guides, ref: null };
}

export function roundTo(v, step, origin = 0) { return origin + Math.round((v - origin) / step) * step; }

export const DIRS = { left: [-1, 0], right: [1, 0], down: [0, -1], up: [0, 1] };
/** Nearest target segment in each axis direction: { left: { d, hit:[x,y], seg }, ... } (missing if none within maxDist). */
export function clearances(p, segs, maxDist = 30) {
  const out = {};
  for (const [name, dir] of Object.entries(DIRS)) {
    let best = null;
    for (const s of segs) {
      const t = rayDistance(p, dir, s.a, s.b);
      if (t !== null && t <= maxDist && (!best || t < best.d)) best = { d: t, hit: add(p, mul(dir, t)), seg: s };
    }
    if (best) out[name] = best;
  }
  return out;
}

/**
 * Positions dividing a — b into n fixtures.
 *   mode 'half'  : end distance = spacing / 2 (spacing = L / n), the usual luminaire layout rule
 *   mode 'equal' : end distance = spacing (n + 1 equal gaps)
 *   mode 'ends'  : first and last fixture on the end points (n − 1 gaps)
 *   mode 'margin': given end distance `margin`, the rest divided equally
 */
export function divide(a, b, n, mode = 'half', margin = 0) {
  n = Math.max(1, n | 0);
  const L = dist(a, b), d = L > 0 ? mul(sub(b, a), 1 / L) : [1, 0];
  let first, step;
  if (mode === 'equal') { step = L / (n + 1); first = step; }
  else if (mode === 'ends') { step = n > 1 ? L / (n - 1) : 0; first = n > 1 ? 0 : L / 2; }
  else if (mode === 'margin') { step = n > 1 ? (L - 2 * margin) / (n - 1) : 0; first = n > 1 ? margin : L / 2; }
  else { step = L / n; first = step / 2; }
  return Array.from({ length: n }, (_, i) => add(a, mul(d, first + i * step)));
}

/** Format metres as integer millimetres (with optional sign). */
export const mm = v => String(Math.round(v * 1000));
/** Parse a command-line coordinate: "x,y" (absolute, mm, relative to origin), "@dx,dy" (relative), "@d<deg" (polar), "d" (distance along direction). */
export function parseCoordinate(text) {
  const s = String(text).trim().replace(/，/g, ',').replace(/＠/g, '@').replace(/\s+/g, '');
  let m;
  if ((m = s.match(/^(@)?(-?\d+(?:\.\d+)?)<(-?\d+(?:\.\d+)?)$/))) {
    const d = +m[2] / 1000, a = +m[3] * Math.PI / 180;
    return { relative: true, value: [d * Math.cos(a), d * Math.sin(a)] };
  }
  if ((m = s.match(/^(@)?(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/))) return { relative: !!m[1], value: [+m[2] / 1000, +m[3] / 1000] };
  if ((m = s.match(/^(-?\d+(?:\.\d+)?)$/))) return { distance: +m[1] / 1000 };
  return null;
}
