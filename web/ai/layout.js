/* WEA AI — layout geometry for the designer agent's tools (pure, unit-tested).
 * Frame: IFC local plan (m). Rooms are given as { footprint, holes }. Room coordinates exposed to the
 * agent are millimetres from the room's bounding-box minimum corner (x → +IFC X, y → +IFC Y).
 */
import { inPolygon } from '../lighting/photometry.js';
import { divide, roundTo, closestOnSegment } from '../lighting/draft/geom2d.js';

export function bbox(ring) {
  const xs = ring.map(p => p[0]), ys = ring.map(p => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
const signedArea = ring => ring.reduce((a, p, i) => { const q = ring[(i + 1) % ring.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0) / 2;

/** Room walls = footprint edges (IfcSpace boundary = finished wall faces). Inward normal, facing, length. */
export function roomWalls(footprint, minLength = 0.3) {
  const ccw = signedArea(footprint) > 0, out = [];
  footprint.forEach((a, i) => {
    const b = footprint[(i + 1) % footprint.length], dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
    if (L < minLength) return;
    const inward = ccw ? [-dy / L, dx / L] : [dy / L, -dx / L];
    const out_ = [-inward[0], -inward[1]];
    const facing = Math.abs(out_[0]) > Math.abs(out_[1]) ? (out_[0] > 0 ? 'E' : 'W') : (out_[1] > 0 ? 'N' : 'S');
    out.push({ index: out.length, a, b, length: L, inward, side: facing });
  });
  return out;
}

/** Pole of inaccessibility (point inside, farthest from the boundary) by iterative grid refinement. */
export function visualCenter(footprint, holes = []) {
  const [x0, y0, x1, y1] = bbox(footprint), rings = [footprint, ...holes];
  const dist = (x, y) => {
    if (!inPolygon(x, y, footprint, holes)) return -1;
    let d = Infinity;
    for (const r of rings) for (let i = 0; i < r.length; i++) d = Math.min(d, closestOnSegment([x, y], r[i], r[(i + 1) % r.length]).d);
    return d;
  };
  let best = [(x0 + x1) / 2, (y0 + y1) / 2], bestD = dist(...best), cx = best[0], cy = best[1], w = (x1 - x0) / 2, h = (y1 - y0) / 2;
  for (let it = 0; it < 6; it++) {
    for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) {
      const x = cx - w + (2 * w * i) / 10, y = cy - h + (2 * h * j) / 10, d = dist(x, y);
      if (d > bestD) { bestD = d; best = [x, y]; }
    }
    [cx, cy] = best; w /= 2.5; h /= 2.5;
  }
  return { point: best, clearance: Math.max(0, bestD) };
}

/**
 * rows × cols grid in a rectangle (default: room bbox minus `inset` from the walls), with the
 * luminaire spacing rule of geom2d.divide ('half': end distance = spacing / 2). Points outside the
 * room polygon (L-shaped rooms) are returned separately, never silently moved.
 */
export function gridLayout(room, rows, cols, { rule = 'half', margin = 0, inset = 0, rect = null } = {}) {
  const [x0, y0, x1, y1] = rect || bbox(room.footprint);
  const ax = [x0 + inset, x1 - inset], ay = [y0 + inset, y1 - inset];
  const xs = divide([ax[0], 0], [ax[1], 0], cols, rule, margin).map(p => p[0]);
  const ys = divide([0, ay[0]], [0, ay[1]], rows, rule, margin).map(p => p[1]);
  const inside = [], outside = [];
  for (const y of ys) for (const x of xs) (inPolygon(x, y, room.footprint, room.holes || []) ? inside : outside).push([x, y]);
  return { points: inside, outside, spacing: [xs.length > 1 ? xs[1] - xs[0] : null, ys.length > 1 ? ys[1] - ys[0] : null] };
}

/** n points parallel to a wall at `offset` from its face, divided along it (ends clear by `endClear` before the rule). */
export function alongWall(wall, n, offset, { rule = 'half', margin = 0, endClear = 0 } = {}) {
  const d = [(wall.b[0] - wall.a[0]) / wall.length, (wall.b[1] - wall.a[1]) / wall.length];
  const a = [wall.a[0] + d[0] * endClear + wall.inward[0] * offset, wall.a[1] + d[1] * endClear + wall.inward[1] * offset];
  const b = [wall.b[0] - d[0] * endClear + wall.inward[0] * offset, wall.b[1] - d[1] * endClear + wall.inward[1] * offset];
  return divide(a, b, n, rule, margin);
}

/** Snap points to the module grid (m) from an origin (plan, m). */
export const snapPoints = (pts, step, origin = [0, 0]) => step > 0 ? pts.map(p => [roundTo(p[0], step, origin[0]), roundTo(p[1], step, origin[1])]) : pts;

/** Aim (tilt from straight down, azimuth in plan from +X) from a fixture at height h above a target point. */
export function aimAt(from, to) {
  const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2], horiz = Math.hypot(dx, dy);
  return { aimTilt: Math.atan2(horiz, -dz) * 180 / Math.PI, aimAzimuth: horiz < 1e-9 ? 0 : Math.atan2(dy, dx) * 180 / Math.PI };
}

export const toRoomMM = (room, p) => [Math.round((p[0] - room.min[0]) * 1000), Math.round((p[1] - room.min[1]) * 1000)];
export const fromRoomMM = (room, q) => [room.min[0] + q[0] / 1000, room.min[1] + q[1] / 1000];
