/* WEA Lighting — luminous surfaces ("赋值发光体"): an existing BIM element whose faces emit light
 * (backlit membranes, light panels, translucent stone, shaped coves …). Pure module (unit-tested).
 *
 * Photometry: an ideal diffuser (Lambertian). One-sided emitting area A with luminance L (cd/m²) sends
 *   Φ = π · L · A   (lm),   I(θ) = L · A · cos θ   (cd)
 * Real-time estimate: the selected faces are cut into patches (≤ `size` m); each patch is a cos¹ emitter
 * (m = 1, I0 = Φ_i / π) along its outward normal, with Φ_i = Φ · a_i / A — total flux is conserved.
 * Radiance gets the same faces as an area light source (`light` material), see tools/radiance_sim.py.
 * Geometry: triangles in IFC local coordinates (m), counter-clockwise = outward normal.
 */
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = v => Math.hypot(v[0], v[1], v[2]);

export const FACE_MODES = { auto: '朝向房间的面', all: '全部面', down: '朝下的面', up: '朝上的面', side: '侧面（竖向）' };

/** tris: flat array [x0,y0,z0, x1,y1,z1, x2,y2,z2, …]; returns [{ a, b, c, n (unit), area }] */
export function triangles(flat) {
  const out = [];
  for (let i = 0; i + 8 < flat.length; i += 9) {
    const a = [flat[i], flat[i + 1], flat[i + 2]], b = [flat[i + 3], flat[i + 4], flat[i + 5]], c = [flat[i + 6], flat[i + 7], flat[i + 8]];
    const n = cross(sub(b, a), sub(c, a)), l = len(n);
    if (l < 1e-10) continue;
    out.push({ a, b, c, n: n.map(v => v / l), area: l / 2 });
  }
  return out;
}

/** Faces that emit. 'auto': faces whose normal points towards `toward` (e.g. the room centre at eye height). */
export function selectFaces(tris, mode = 'auto', toward = null) {
  return tris.filter(t => {
    const nz = t.n[2];
    if (mode === 'down') return nz < -0.5;
    if (mode === 'up') return nz > 0.5;
    if (mode === 'side') return Math.abs(nz) <= 0.5;
    if (mode === 'auto' && toward) {
      const c = [(t.a[0] + t.b[0] + t.c[0]) / 3, (t.a[1] + t.b[1] + t.c[1]) / 3, (t.a[2] + t.b[2] + t.c[2]) / 3];
      const d = sub(toward, c); return d[0] * t.n[0] + d[1] * t.n[1] + d[2] * t.n[2] > 0;
    }
    return true;
  });
}

/** Cut triangles into patches no larger than `size` m (barycentric grid); coarsen until ≤ maxPatches. */
export function patches(tris, { size = 0.1, maxPatches = 600 } = {}) {
  const area = tris.reduce((s, t) => s + t.area, 0);
  if (!tris.length || area <= 0) return { patches: [], area: 0 };
  let s = Math.max(size, Math.sqrt(area / maxPatches) * 1.2);
  for (;;) {
    const out = [];
    for (const t of tris) {
      const e = Math.max(len(sub(t.b, t.a)), len(sub(t.c, t.b)), len(sub(t.a, t.c)));
      const k = Math.max(1, Math.ceil(e / s));                          // k² sub-triangles
      const P = (i, j) => { const u = i / k, v = j / k; return [0, 1, 2].map(q => t.a[q] + (t.b[q] - t.a[q]) * u + (t.c[q] - t.a[q]) * v); };
      const sa = t.area / (k * k);
      for (let i = 0; i < k; i++) for (let j = 0; j < k - i; j++) {
        const p0 = P(i, j), p1 = P(i + 1, j), p2 = P(i, j + 1);
        out.push({ p: [0, 1, 2].map(q => (p0[q] + p1[q] + p2[q]) / 3), n: t.n, a: sa });
        if (i + j < k - 1) { const p3 = P(i + 1, j + 1); out.push({ p: [0, 1, 2].map(q => (p1[q] + p2[q] + p3[q]) / 3), n: t.n, a: sa }); }
      }
    }
    if (out.length <= maxPatches || s > 50) return { patches: out, area, size: s };
    s *= Math.sqrt(out.length / maxPatches) * 1.05;
  }
}

/** Rotate triangles about centre c by unit quaternion q = [x, y, z, w] (IFC local). Returns new triangles. */
export function rotateTriangles(tris, q, c) {
  const [x, y, z, w] = q;
  if (!q || Math.abs(w) > 1 - 1e-12) return tris;
  const R = [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
             2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
             2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)];
  const rv = v => [R[0] * v[0] + R[1] * v[1] + R[2] * v[2], R[3] * v[0] + R[4] * v[1] + R[5] * v[2], R[6] * v[0] + R[7] * v[1] + R[8] * v[2]];
  const rp = v => { const r = rv(sub(v, c)); return [r[0] + c[0], r[1] + c[1], r[2] + c[2]]; };
  return tris.map(t => ({ a: rp(t.a), b: rp(t.b), c: rp(t.c), n: rv(t.n), area: t.area }));
}
export const isRotated = q => !!q && Math.abs(q[3]) < 1 - 1e-9;

/** cos¹ emitters for the illuminance engine (photometry.illuminanceAt); offset moves the whole surface. */
export function emitters(pp, flux, offset = [0, 0, 0]) {
  const A = pp.area; if (!(A > 0) || !(flux > 0)) return [];
  return pp.patches.map(q => { const f = flux * q.a / A; return { p: [q.p[0] + offset[0], q.p[1] + offset[1], q.p[2] + offset[2]], axis: q.n, m: 1, I0: f / Math.PI, flux: f }; });
}

export const fluxFromLuminance = (L, area) => Math.PI * L * area;
export const luminanceFromFlux = (flux, area) => area > 0 ? flux / (Math.PI * area) : 0;
