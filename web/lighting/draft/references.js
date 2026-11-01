/* WEA Drafting — reference linework for plan positioning, derived from the converted BIM geometry
 * (read-only) and rooms.json. Generic for any IFC: nothing depends on entity classes (Archicad
 * exports everything as proxies), only on geometry and the converter's category / discipline.
 *   planCut       horizontal section of architectural elements at a given height (walls, columns,
 *                 doors / windows, furniture) — wall finish faces are what dimensions measure to
 *   ceilingEdges  outlines of down-facing architectural surfaces between two heights (ceiling
 *                 steps, coves, bulkheads, slab edges): boundary edges of the down-facing mesh
 *   gridLines     IfcGrid axes of the storey (rooms.json `grids`)
 * Input geometry is in view coordinates (x, y, z)_view = (xL, zL, −yL); output in IFC local plan (m).
 */
import { mergeSegments } from './geom2d.js';

const WALLISH = new Set([1, 3]);          // converter categories: walls, beams / columns

function elementMask(elements, accept) {
  const m = new Uint8Array(elements.length);
  elements.forEach((e, i) => { m[i] = accept(e, i) ? 1 : 0; });
  return m;
}
const overlaps = (bb, box) => !box || (bb[0] <= box[2] && bb[3] >= box[0] && -bb[5] <= box[3] && -bb[2] >= box[1]);

/** box: [x0, y0, x1, y1] IFC local plan extent. */
export function planCut(geometry, elements, { z, box = null, include = null }) {
  const P = geometry.position, el = geometry.element, cover = geometry.cover, n = geometry.vertices;
  const mask = elementMask(elements, (e, i) => (!include || include(i)) && e.bbox && e.discipline !== 'MEP' && e.category !== 7 && e.category !== 2
    && e.bbox[1] <= z && e.bbox[4] >= z && overlaps(e.bbox, box));
  const raw = [];
  for (let v = 0; v < n; v += 3) {
    const k = el[v]; if (!mask[k] || cover[v]) continue;
    const i = v * 3, y0 = P[i + 1] - z, y1 = P[i + 4] - z, y2 = P[i + 7] - z;
    if ((y0 > 0 && y1 > 0 && y2 > 0) || (y0 < 0 && y1 < 0 && y2 < 0)) continue;
    const pts = [];
    const edge = (a, b, da, db) => {
      if ((da > 0) === (db > 0) && da !== 0 && db !== 0) return;
      if (da === 0 && db === 0) return;                           // edge lying in the plane: neighbours supply it
      const t = da / (da - db);
      pts.push([P[i + a * 3] + (P[i + b * 3] - P[i + a * 3]) * t, -(P[i + a * 3 + 2] + (P[i + b * 3 + 2] - P[i + a * 3 + 2]) * t)]);
    };
    edge(0, 1, y0, y1); edge(1, 2, y1, y2); edge(2, 0, y2, y0);
    if (pts.length < 2) continue;
    const [a, b] = pts[0][0] === pts[1][0] && pts[0][1] === pts[1][1] && pts[2] ? [pts[0], pts[2]] : pts;
    raw.push({ a, b, kind: WALLISH.has(elements[k].category) ? 'wall' : 'other', el: k });
  }
  return mergeSegments(raw);
}

/** Outlines of down-facing architectural surfaces with zmin ≤ z ≤ zmax (IFC local heights). */
export function ceilingEdges(geometry, elements, { zmin, zmax, box = null, include = null }) {
  const P = geometry.position, el = geometry.element, cover = geometry.cover, n = geometry.opaqueVertices;
  const mask = elementMask(elements, (e, i) => (!include || include(i)) && e.bbox && e.discipline !== 'MEP' && e.category !== 7
    && e.bbox[4] >= zmin && e.bbox[1] <= zmax && overlaps(e.bbox, box));
  const q = x => Math.round(x * 1000);
  const count = new Map();
  for (let v = 0; v < n; v += 3) {
    const k = el[v]; if (!mask[k] || cover[v]) continue;
    const i = v * 3;
    const ax = P[i], ay = P[i + 1], az = P[i + 2], bx = P[i + 3], by = P[i + 4], bz = P[i + 5], cx = P[i + 6], cy = P[i + 7], cz = P[i + 8];
    if (ay < zmin || ay > zmax || Math.abs(ay - by) > 0.005 || Math.abs(ay - cy) > 0.005) continue;   // horizontal faces in range
    const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);          // view-Y component of (b−a)×(c−a)
    const area = Math.abs(ny) / 2; if (area < 1e-6) continue;
    // down-facing: CCW winding from below; the converter keeps outward normals, so ny < 0 faces down
    if (ny >= 0) continue;
    const V = [[ax, -az], [bx, -bz], [cx, -cz]], h = q(ay);
    for (let j = 0; j < 3; j++) {
      const a = V[j], b = V[(j + 1) % 3];
      const ka = q(a[0]) + ',' + q(a[1]), kb = q(b[0]) + ',' + q(b[1]);
      const key = h + '|' + (ka < kb ? ka + '|' + kb : kb + '|' + ka);
      const c = count.get(key); if (c) c.n++; else count.set(key, { n: 1, a, b, el: k });
    }
  }
  const raw = [];
  for (const c of count.values()) if (c.n === 1) raw.push({ a: c.a, b: c.b, kind: 'ceiling', el: c.el });
  return mergeSegments(raw);
}

/** IfcGrid axes for a storey: rooms.json grids → axis segments, duplicates removed. */
export function gridLines(grids, storeyName) {
  const seen = new Set(), out = [];
  for (const g of grids || []) {
    if (storeyName && g.storey && g.storey !== storeyName) continue;
    for (const ax of g.axes) for (let i = 0; i + 1 < ax.points.length; i++) {
      const a = ax.points[i], b = ax.points[i + 1];
      const key = [a, b].map(p => p.map(v => Math.round(v * 1000)).join(',')).sort().join('|');
      if (seen.has(key)) continue; seen.add(key);
      out.push({ a, b, kind: 'axis', label: ax.tag, grid: g.name });
    }
  }
  return out;
}
