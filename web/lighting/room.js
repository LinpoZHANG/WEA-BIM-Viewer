/* WEA Lighting — room working context.
 * Source: converter `element.room` (IfcSpace footprint, floor, measured ceiling levels with
 * coverage) in IFC local coordinates (Z-up, m). Anything the converter could not verify is
 * flagged (needsConfirmation/issues) and can be overridden manually per room; overrides are
 * stored in the design, never written back to the IFC.
 * Room-local frame: origin = (footprint bbox min x, min y, floor), axes = IFC X/Y/Z.
 */
import { inPolygon } from './photometry.js';

export class RoomContext {
  constructor(element, index, override = null) {
    const r = element.room;
    this.element = element; this.index = index;
    this.id = element.guid; this.expressId = element.id; this.name = element.name;
    this.auto = r;
    this.override = override || null;
    const o = this.override || {};
    this.footprint = o.footprint || r.footprint;
    this.holes = o.footprint ? [] : (r.holes || []);
    this.floor = o.floor ?? r.floor;
    this.ceilings = r.ceilings || [];
    this.ceiling = o.ceiling ?? (this.ceilings[0]?.z ?? null);      // default mount plane: most common ceiling level
    this.top = r.top;
    this.issues = [...(r.issues || [])];
    if (!this.ceilings.length) this.issues.push('未探测到天花，需人工指定安装高度');
    this.needsConfirmation = (r.needsConfirmation || !this.ceilings.length) && !o.confirmed;
    const xs = this.footprint.map(p => p[0]), ys = this.footprint.map(p => p[1]);
    this.min = [Math.min(...xs), Math.min(...ys)]; this.max = [Math.max(...xs), Math.max(...ys)];
    this.area = o.footprint ? polygonArea(this.footprint) : r.area;
  }
  contains(xL, yL, margin = 0) {
    if (inPolygon(xL, yL, this.footprint, this.holes)) return true;
    if (!margin) return false;
    return [[margin, 0], [-margin, 0], [0, margin], [0, -margin]].some(([dx, dy]) => inPolygon(xL + dx, yL + dy, this.footprint, this.holes));
  }
  localToRoom([x, y, z]) { return [x - this.min[0], y - this.min[1], z - this.floor]; }
  /** Y-up view bbox [x0,y0,z0,x1,y1,z1] of the room volume (floor .. ceiling or space top). */
  viewBBox(frames) {
    const topZ = Math.max(this.ceiling ?? this.top, this.top);
    const a = frames.localToView([this.min[0], this.min[1], this.floor]), b = frames.localToView([this.max[0], this.max[1], topZ]);
    return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2]), Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])];
  }
}

export function polygonArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  return Math.abs(a / 2);
}

export function roomsFromModel(elements, overrides = {}) {
  return elements.map((e, i) => e.room ? new RoomContext(e, i, overrides[e.guid]) : null).filter(Boolean)
    .sort((a, b) => a.area - b.area);   // smallest first: a point inside nested spaces belongs to the room, not the whole unit
}

/** Whole-unit spaces (an IfcSpace containing ≥ 2 other rooms, e.g. "户型D") are not rooms to light. */
export function isContainerSpace(rooms, r) {
  return rooms.filter(o => o !== r && o.area < r.area && r.contains((o.min[0] + o.max[0]) / 2, (o.min[1] + o.max[1]) / 2)).length >= 2;
}
/** Rooms a designer would light: not whole-unit containers, at least `minArea` m². */
export function designRooms(rooms, minArea = 1) {
  return rooms.filter(r => r.area >= minArea && !isContainerSpace(rooms, r));
}

/** Room containing a local point: the smallest footprint that contains it (whole-unit spaces lose to rooms). */
export function roomAt(rooms, xL, yL) {
  return rooms.find(r => r.contains(xL, yL)) || null;
}
