/* WEA Lighting — Radiance simulation client (server: POST/GET /api/lighting/simulate, tools/radiance_sim.py).
 * The request is built from the same work-plane grid and the same photometry.fixtureEmitters()
 * as the real-time estimate, so both analyses describe identical fixtures and sample points.
 * A result is only shown while its request key matches the current design (otherwise "stale").
 */
import * as P from './photometry.js';
import { northRotation } from './sun.js';

export const QUALITY_LABELS = { draft: '草图（2 次反射）', standard: '标准（4 次反射）', high: '精细（6 次反射）' };
export const SKY_LABELS = { clear: '晴天（含直射日光）', intermediate: '多云（中间天空）', overcast: '阴天（CIE 全阴天）' };
const REGION_MARGIN = 6;     // m around the room included in the simulation geometry

export function defaultSimulationSettings(site) {
  const known = site && Number.isFinite(site.latitude) && Number.isFinite(site.longitude);
  return {
    quality: 'standard', electric: true, otherRooms: false,
    daylight: { enabled: false, year: new Date().getFullYear(), month: 3, day: 21, hour: 10, sky: 'clear',
      latitude: known ? +site.latitude.toFixed(4) : 39.9, longitude: known ? +site.longitude.toFixed(4) : 116.4,
      timezone: 8, northOffset: 0, locationSource: known ? 'IfcSite' : 'manual' },
    materialReflectance: {},
  };
}

/** Fixtures that light the room in the simulation: the room's own, plus (optionally) any within the region. */
export function simulatedFixtures(fixtures, room, frames, otherRooms) {
  return fixtures.filter(f => {
    if (f.roomId === room.id) return true;
    if (!otherRooms) return false;
    const [x, y] = frames.worldToLocal(f.position.ifcWorld);
    return x > room.min[0] - REGION_MARGIN && x < room.max[0] + REGION_MARGIN && y > room.min[1] - REGION_MARGIN && y < room.max[1] + REGION_MARGIN;
  });
}

export function buildRequest({ room, grid, fixtures, frames, settings, trueNorth }) {
  const s = settings, d = s.daylight;
  const lit = s.electric ? simulatedFixtures(fixtures, room, frames, s.otherRooms) : [];
  // luminous surfaces go to Radiance as area light sources (their faces, 1 mm proud, uniform luminance)
  const areaSources = lit.filter(f => f.fixtureType === 'luminous').map(f => {
    const g = P.LUMINOUS.get(f.fixtureId), flux = P.effectiveFlux(f.photometricParameters); if (!g?.faces?.length || !(flux > 0)) return null;
    const l = frames.worldToLocal(f.position.ifcWorld), off = [0, 1, 2].map(i => l[i] - g.origin[i]);
    return { label: f.name, luminance: +(flux / (Math.PI * g.area)).toFixed(3), cct: f.photometricParameters.cct,
      triangles: g.faces.map(t => [t.a, t.b, t.c].map(v => [0, 1, 2].map(i => +(v[i] + off[i] + t.n[i] * 0.001).toFixed(5)))) };
  }).filter(Boolean);
  const emitters = lit.filter(f => f.fixtureType !== 'luminous').flatMap(f =>
    P.fixtureEmitters(f, frames.worldToLocal(f.position.ifcWorld)).filter(e => e.flux > 0)
      .map(e => ({ p: e.p.map(v => +v.toFixed(5)), axis: e.axis.map(v => +v.toFixed(6)), m: +e.m.toFixed(5), flux: +e.flux.toFixed(4), label: f.name })));
  return {
    room: { id: room.id, footprint: room.footprint, holes: room.holes, floor: room.floor, ceiling: room.ceiling },
    sensors: grid.points.map(p => p.map(v => +v.toFixed(4))), normal: [0, 0, 1],
    emitters, areaSources, electric: s.electric, quality: s.quality, margin: REGION_MARGIN,
    daylight: d.enabled ? { enabled: true, month: d.month, day: d.day, hour: d.hour, sky: d.sky, latitude: d.latitude,
      longitude: d.longitude, timezone: d.timezone, northRotation: +northRotation(trueNorth, d.northOffset).toFixed(4) } : { enabled: false },
    materialReflectance: s.materialReflectance || {},
  };
}

export function requestKey(req) {
  const text = JSON.stringify(req);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16) + ':' + text.length;
}

export async function runSimulation(req, onProgress, signal) {
  const r = await fetch('/api/lighting/simulate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req) });
  const start = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(start.error || '仿真启动失败（' + r.status + '）');
  for (;;) {
    await new Promise(res => setTimeout(res, 700));
    if (signal?.aborted) throw new Error('已取消');
    const s = await (await fetch('/api/lighting/simulate?job=' + start.job, { cache: 'no-store' })).json();
    if (s.status === 'done') return s.result;
    if (s.status === 'error') throw new Error(s.error || '仿真失败');
    onProgress?.(s.phase, s.progress, (Date.now() / 1000 - s.started));
  }
}

/** Statistics excluding sensors inside objects. */
export function statsExcluding(values, blocked) {
  const skip = new Set(blocked || []);
  return P.illuminanceStats(values.filter((_, k) => !skip.has(k)));
}
