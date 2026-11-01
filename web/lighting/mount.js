/* WEA Lighting — mount-surface verification on the CPU.
 * Casts a short ray from a fixture towards its mount surface against the converted BIM
 * triangles (read-only), restricted to elements whose bbox the ray crosses. Used after moves
 * and when a saved design is reopened, so a fixture whose ceiling/wall no longer exists is
 * reported instead of being silently shown in a wrong place.
 */
export class MountChecker {
  constructor(viewer) {
    this.viewer = viewer; this.ranges = null;
  }
  /** element index -> [[firstVertex, vertexCount], ...] over the opaque (non-duplicate) geometry */
  index() {
    if (this.ranges) return this.ranges;
    const g = this.viewer.geometry, el = g.element, ranges = new Map();
    let start = 0;
    for (let v = 3; v <= g.opaqueVertices; v += 3) {
      if (v === g.opaqueVertices || el[v] !== el[start] || g.cover[v] !== g.cover[start]) {
        if (!g.cover[start]) { const k = el[start]; (ranges.get(k) || ranges.set(k, []).get(k)).push([start, v - start]); }
        start = v;
      }
    }
    return this.ranges = ranges;
  }
  /** Ray in view coords. Returns nearest hit { index, t, normal (unit, view coords, unoriented) } within maxT, or null. */
  raycast(origin, dir, maxT, accept = () => true) {
    const g = this.viewer.geometry, P = g.position, els = this.viewer.elements, ranges = this.index();
    let best = null;
    const end = [origin[0] + dir[0] * maxT, origin[1] + dir[1] * maxT, origin[2] + dir[2] * maxT];
    const lo = [0, 1, 2].map(k => Math.min(origin[k], end[k]) - 0.01), hi = [0, 1, 2].map(k => Math.max(origin[k], end[k]) + 0.01);
    for (const [k, list] of ranges) {
      const b = els[k]?.bbox;
      if (!b || b[0] > hi[0] || b[3] < lo[0] || b[1] > hi[1] || b[4] < lo[1] || b[2] > hi[2] || b[5] < lo[2] || !accept(k, els[k])) continue;
      for (const [s, n] of list) for (let v = s; v < s + n; v += 3) {
        const t = rayTriangle(origin, dir, P, v * 3);
        if (t !== null && t >= 0 && t <= maxT && (!best || t < best.t)) best = { index: k, t, v };
      }
    }
    if (best) {
      const i = best.v * 3, e1 = [P[i + 3] - P[i], P[i + 4] - P[i + 1], P[i + 5] - P[i + 2]], e2 = [P[i + 6] - P[i], P[i + 7] - P[i + 1], P[i + 8] - P[i + 2]];
      const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]], l = Math.hypot(...n) || 1;
      best.normal = n.map(c => c / l);
    }
    return best;
  }
}

/** Möller–Trumbore, double-sided. Returns t or null. */
function rayTriangle(o, d, P, i) {
  const ax = P[i], ay = P[i + 1], az = P[i + 2];
  const e1x = P[i + 3] - ax, e1y = P[i + 4] - ay, e1z = P[i + 5] - az;
  const e2x = P[i + 6] - ax, e2y = P[i + 7] - ay, e2z = P[i + 8] - az;
  const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-12) return null;
  const inv = 1 / det, tx = o[0] - ax, ty = o[1] - ay, tz = o[2] - az;
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < 0 || u > 1) return null;
  const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
  const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
  if (v < 0 || u + v > 1) return null;
  return (e2x * qx + e2y * qy + e2z * qz) * inv;
}
