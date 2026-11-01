/* WEA Lighting — interior envelope ("外圈"): the elements actually visible from inside the rooms.
 * Lighting only sees the innermost layer: finishes, built-in furniture, doors / windows / glass, and the
 * structure wherever there is no finish. Substrates, studs, structure behind finishes and services above a
 * closed ceiling are invisible from every room and only add geometry, overlap and cost.
 *
 * Method (generic, no layer names): sample points inside every room (two heights), render 6 × 90° id views
 * from each with the viewer's picking shader (viewer.visibleFrom), twice — with glass, and looking through
 * glass (opaque only) so exterior shading elements seen through windows stay for daylight. The envelope is
 * the union of all elements seen. It cannot leak light by construction: every sight line from inside a room
 * ends on an element that is kept (where a finish is missing, the structure behind it is seen and kept).
 * Result cached per model fingerprint (localStorage, element GlobalIds).
 */
import { designRooms } from './room.js';
import { inPolygon } from './photometry.js';

const KEY = 'wea-envelope-v2:';

/* Layers never part of what a room shows, by common naming (CAD layer from IfcPresentationLayerAssignment):
   substrate / studs / joints / grids / documentation / hidden / imported reference models. Editable per design. */
export const DEFAULT_LAYER_EXCLUDE = /基层|SUBSTRATE|龙骨|分缝|SPLIT|IFC\s*Model|IFC图层|DOKU|文档|HIDE|隐藏|轴线|GRID|REFERENCE|参照/i;
export function defaultExcludedLayers(elements) {
  return [...new Set(elements.map(e => e.layer).filter(l => l && DEFAULT_LAYER_EXCLUDE.test(l) && !/门窗|DOOR|WINDOW/i.test(l)))].sort();
}
export function layerStats(elements) {
  const m = new Map();
  for (const e of elements) if (e.bbox && e.category !== 7) m.set(e.layer || '（无图层）', (m.get(e.layer || '（无图层）') || 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]);
}
/** cache key part for a set of excluded layers */
export function layersKey(list) { let h = 0x811c9dc5; for (const ch of [...list].sort().join('|')) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16); }

/** sample points (IFC local) per room: grid cells ≥ inset from the boundary, spread by farthest-point choice */
export function samplePoints(rooms, { spacing = 1.6, perRoom = 4, inset = 0.35 } = {}) {
  const out = [];
  for (const r of rooms) {
    const cand = [];
    for (let x = r.min[0] + inset; x <= r.max[0] - inset + 1e-9; x += spacing / 2)
      for (let y = r.min[1] + inset; y <= r.max[1] - inset + 1e-9; y += spacing / 2)
        if ([[0, 0], [inset, 0], [-inset, 0], [0, inset], [0, -inset]].every(([dx, dy]) => inPolygon(x + dx, y + dy, r.footprint, r.holes || []))) cand.push([x, y]);
    if (!cand.length) {                                                    // narrow room: centre of the bbox if inside
      const c = [(r.min[0] + r.max[0]) / 2, (r.min[1] + r.max[1]) / 2];
      if (inPolygon(c[0], c[1], r.footprint, r.holes || [])) cand.push(c); else continue;
    }
    const mid = [(r.min[0] + r.max[0]) / 2, (r.min[1] + r.max[1]) / 2];
    const pick = [cand.reduce((a, b) => Math.hypot(b[0] - mid[0], b[1] - mid[1]) < Math.hypot(a[0] - mid[0], a[1] - mid[1]) ? b : a)];
    while (pick.length < Math.min(perRoom, cand.length)) {
      let best = null, bd = -1;
      for (const c of cand) { const d = Math.min(...pick.map(p => Math.hypot(c[0] - p[0], c[1] - p[1]))); if (d > bd) { bd = d; best = c; } }
      if (bd < spacing * 0.6) break; pick.push(best);
    }
    const top = r.ceiling != null && r.ceiling > r.floor + 1.8 ? r.ceiling - 0.35 : r.floor + 2.2;
    for (const [x, y] of pick) out.push([x, y, r.floor + 1.2], [x, y, Math.max(r.floor + 1.5, top)]);
  }
  return out;
}

export async function computeEnvelope(viewer, rooms, frames, progress = () => {}) {
  const pts = samplePoints(designRooms(rooms)).map(p => frames.localToView(p));
  const a = await viewer.visibleFrom(pts, { progress: f => progress(f / 2) });
  const b = await viewer.visibleFrom(pts, { opaqueOnly: true, progress: f => progress(0.5 + f / 2) });
  const keep = new Set([...a, ...b]);
  return { keep, points: pts.length };
}

export function loadEnvelope(fingerprint, elements) {
  try {
    const raw = localStorage.getItem(KEY + fingerprint); if (!raw) return null;
    const guids = new Set(JSON.parse(raw).guids), keep = new Set();
    elements.forEach((e, i) => { if (guids.has(e.guid)) keep.add(i); });
    return { keep, cached: true };
  } catch { return null; }
}
export function saveEnvelope(fingerprint, elements, keep) {
  try { localStorage.setItem(KEY + fingerprint, JSON.stringify({ guids: [...keep].map(i => elements[i]?.guid).filter(Boolean), at: new Date().toISOString() })); } catch { /* quota: recompute next time */ }
}
