/* WEA Lighting — photometric model and direct illuminance calculation.
 * Pure module (no three.js, no DOM) so the same code runs in the browser and in `node --test`.
 *
 * Frame: IFC local coordinates, Z-up, metres (see coords.js). Angles in degrees at the API.
 *
 * Generic (simulated) luminous intensity distribution, rotationally symmetric about the
 * fixture's aim axis:
 *     I(θ) = I0 · cos^m(θ)   for θ < 90°,   0 otherwise
 * Beam angle β is the full width at half maximum: cos^m(β/2) = 0.5  →  m = ln 0.5 / ln cos(β/2).
 * Flux conservation over the emitting hemisphere: Φ = ∫ I dΩ = 2π I0 / (m + 1)  →  I0 = Φ (m + 1) / 2π.
 * (lm is never used as cd; the beam angle shapes the distribution, it is not an illuminance.)
 *
 * Direct illuminance at a point P with surface normal n from an emitter at S with axis a:
 *     E = Σ I(θ) · cos(α) / r²,   r = |S − P|,  cos θ = a · (P − S)/r,  cos α = n · (S − P)/r
 * Not modelled: occlusion by walls/objects, inter-reflections (indirect light), luminaire
 * maintenance factor. Results are an early-design estimate, not a lighting simulation.
 */

export const DISTRIBUTION_MODEL = 'generic-cosine-power-v1';
export const FIXTURE_KINDS = ['downlight', 'spotlight', 'linear', 'pendant', 'ceiling', 'luminous'];
/* Luminous surfaces (BIM elements assigned as emitters): fixtureId -> { patches, area, origin (IFC local of
   position.ifcWorld when built) }, filled by the workspace from the BIM geometry (never stored in the design). */
export const LUMINOUS = new Map();
export const BEAM_MIN = 10, BEAM_MAX = 120;      // deg; 120° FWHM = Lambertian (m = 1)
export const LINEAR_SEGMENT = 0.25;              // m, max sub-source spacing for linear fixtures
const D2R = Math.PI / 180;

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function exponentForBeam(beamDeg) {
  const half = clamp(beamDeg, BEAM_MIN, BEAM_MAX) / 2 * D2R;
  return Math.log(0.5) / Math.log(Math.cos(half));
}

export function peakIntensity(flux, m) {
  return flux * (m + 1) / (2 * Math.PI);
}

export function intensityAt(I0, m, cosTheta) {
  return cosTheta > 0 ? I0 * Math.pow(cosTheta, m) : 0;
}

/** Half-angle (deg) beyond which I/I0 < fraction; used to size the visual preview cone. */
export function cutoffAngle(m, fraction = 0.005) {
  return Math.acos(Math.pow(fraction, 1 / m)) / D2R;
}

/** Unit aim vector (IFC local, Z-up) from tilt (deg from straight down) and azimuth (deg in plan from +X towards +Y). */
export function aimVector(tiltDeg, azimuthDeg) {
  const t = tiltDeg * D2R, a = azimuthDeg * D2R;
  return [Math.sin(t) * Math.cos(a), Math.sin(t) * Math.sin(a), -Math.cos(t)];
}

/** Effective luminous flux after on/off and dimming. */
export function effectiveFlux(p) {
  return p.on === false ? 0 : Math.max(0, p.flux) * clamp(p.dimming ?? 100, 0, 100) / 100;
}

/**
 * Point emitters of a fixture. `posLocal` is the luminous centre in IFC local coords (m).
 * Linear fixtures become evenly spaced sub-sources along their length; total flux is preserved.
 * Returns [{ p:[x,y,z], axis:[x,y,z], I0 (cd), m, flux (lm) }].
 */
export function fixtureEmitters(fixture, posLocal) {
  const ph = fixture.photometricParameters, rot = fixture.rotation || {};
  const flux = effectiveFlux(ph);
  const m = exponentForBeam(ph.beamAngle);
  const axis = aimVector(rot.aimTilt || 0, rot.aimAzimuth || 0);
  if (fixture.fixtureType === 'luminous') {          // area source: cos¹ patches over the emitting faces, flux by area
    const g = LUMINOUS.get(fixture.fixtureId); if (!g || !g.area) return [];
    const off = [posLocal[0] - g.origin[0], posLocal[1] - g.origin[1], posLocal[2] - g.origin[2]];
    return g.patches.map(q => { const f = flux * q.a / g.area; return { p: [q.p[0] + off[0], q.p[1] + off[1], q.p[2] + off[2]], axis: q.n, I0: f / Math.PI, m: 1, flux: f }; });
  }
  if (fixture.fixtureType === 'pendant') {         // two lobes: down (beam angle) + up (Lambertian), flux split by upRatio
    const up = clamp(ph.upRatio ?? 0.3, 0, 1), fd = flux * (1 - up), fu = flux * up;
    return [{ p: posLocal, axis, I0: peakIntensity(fd, m), m, flux: fd }, { p: posLocal, axis: [0, 0, 1], I0: peakIntensity(fu, 1), m: 1, flux: fu }];
  }
  if (fixture.fixtureType !== 'linear') {
    return [{ p: posLocal, axis, I0: peakIntensity(flux, m), m, flux }];
  }
  const L = Math.max(0.01, ph.length || 1), n = Math.max(1, Math.ceil(L / LINEAR_SEGMENT));
  const b = (rot.bodyRotation || 0) * D2R, dir = [Math.cos(b), Math.sin(b), 0];
  const out = [];
  for (let k = 0; k < n; k++) {
    const s = (k + 0.5) / n * L - L / 2;
    out.push({ p: [posLocal[0] + dir[0] * s, posLocal[1] + dir[1] * s, posLocal[2]], axis,
      I0: peakIntensity(flux / n, m), m, flux: flux / n });
  }
  return out;
}

/** Direct illuminance (lux) at point p with unit normal n from a list of emitters. */
export function illuminanceAt(p, n, emitters) {
  let E = 0;
  for (const e of emitters) {
    if (e.I0 <= 0) continue;
    const vx = e.p[0] - p[0], vy = e.p[1] - p[1], vz = e.p[2] - p[2];
    const r2 = vx * vx + vy * vy + vz * vz;
    if (r2 < 1e-6) continue;
    const r = Math.sqrt(r2), dx = vx / r, dy = vy / r, dz = vz / r;   // point -> source
    const cosA = n[0] * dx + n[1] * dy + n[2] * dz;
    if (cosA <= 0) continue;
    const cosT = -(e.axis[0] * dx + e.axis[1] * dy + e.axis[2] * dz);  // source -> point vs axis
    E += intensityAt(e.I0, e.m, cosT) * cosA / r2;
  }
  return E;
}

/* ---------- calculation grid clipped to the room ---------- */

function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function inPolygon(x, y, outer, holes = []) {
  return inRing(x, y, outer) && !holes.some(h => inRing(x, y, h));
}

/** Auto grid spacing: 0.25 m for rooms up to 40 m², 0.5 m above. */
export function autoSpacing(area) {
  return area > 40 ? 0.5 : 0.25;
}

/**
 * Sample points of the horizontal work plane: cell centres of a regular grid that fall
 * inside the room footprint (holes excluded). Returns { points:[[x,y,z]], spacing, origin, nx, ny, index:[i,j] per point }.
 */
function distToSegment(x, y, [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L)) : 0;
  return Math.hypot(x - ax - t * dx, y - ay - t * dy);
}

/** Distance from (x, y) to the nearest edge of the footprint or a hole. */
export function distanceToBoundary(x, y, footprint, holes = []) {
  let d = Infinity;
  for (const ring of [footprint, ...holes]) for (let i = 0; i < ring.length; i++) d = Math.min(d, distToSegment(x, y, ring[i], ring[(i + 1) % ring.length]));
  return d;
}

export function workplaneGrid(footprint, holes, z, spacing, border = 0) {
  const xs = footprint.map(p => p[0]), ys = footprint.map(p => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const nx = Math.max(1, Math.ceil((x1 - x0) / spacing)), ny = Math.max(1, Math.ceil((y1 - y0) / spacing));
  const points = [], index = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const x = x0 + (i + 0.5) * spacing, y = y0 + (j + 0.5) * spacing;
    if (inPolygon(x, y, footprint, holes) && (!border || distanceToBoundary(x, y, footprint, holes) >= border)) { points.push([x, y, z]); index.push([i, j]); }
  }
  return { points, index, spacing, origin: [x0, y0], nx, ny, z, border };
}

export function gridIlluminance(points, emitters, normal = [0, 0, 1]) {
  const out = new Float64Array(points.length);
  for (let k = 0; k < points.length; k++) out[k] = illuminanceAt(points[k], normal, emitters);
  return out;
}

/** p-th percentile (0–100) of the values (linear interpolation). */
export function percentile(values, p) {
  if (!values.length) return 0;
  const s = Float64Array.from(values).sort(), k = (s.length - 1) * Math.min(100, Math.max(0, p)) / 100;
  const i = Math.floor(k);
  return i + 1 < s.length ? s[i] + (s[i + 1] - s[i]) * (k - i) : s[i];
}

export function illuminanceStats(values) {
  if (!values.length) return null;
  let sum = 0, min = Infinity, max = -Infinity;
  for (const v of values) { sum += v; if (v < min) min = v; if (v > max) max = v; }
  const avg = sum / values.length;
  return { Eavg: avg, Emin: min, Emax: max, U0: avg > 0 ? min / avg : null, samples: values.length };
}

/* ---------- parameter validation ---------- */

export const LIMITS = {
  flux: [0, 30000, 'lm'], power: [0, 500, 'W'], beamAngle: [BEAM_MIN, BEAM_MAX, '°'], cct: [1800, 6500, 'K'],
  dimming: [0, 100, '%'], length: [0.1, 6, 'm'], upRatio: [0, 1, ''], suspension: [0.05, 3, 'm'], diameter: [0.1, 2, 'm'], aimTilt: [0, 90, '°'], aimAzimuth: [-360, 360, '°'], bodyRotation: [-360, 360, '°'],
};

export function validateFixture(f) {
  const errors = [], ph = f.photometricParameters || {}, rot = f.rotation || {};
  const check = (key, v) => {
    const [lo, hi, unit] = LIMITS[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) errors.push(`${key} 必须是数字`);
    else if (v < lo || v > hi) errors.push(`${key} 应在 ${lo}–${hi} ${unit} 之间`);
  };
  for (const k of ['flux', 'power', 'beamAngle', 'cct', 'dimming']) {
    if (k === 'flux' && f.fixtureType === 'luminous') { if (!(ph.flux >= 0 && ph.flux <= 1e6)) errors.push('flux 应在 0–1000000 lm 之间'); continue; }   // large luminous areas
    check(k, ph[k]);
  }
  if (f.fixtureType === 'linear') check('length', ph.length);
  if (f.fixtureType === 'pendant') for (const k of ['upRatio', 'suspension']) check(k, ph[k]);
  for (const k of ['aimTilt', 'aimAzimuth', 'bodyRotation']) check(k, rot[k] ?? 0);
  const pos = f.position?.ifcWorld;
  if (!Array.isArray(pos) || pos.length !== 3 || !pos.every(Number.isFinite)) errors.push('位置坐标无效');
  if (!FIXTURE_KINDS.includes(f.fixtureType)) errors.push('未知灯具类型');
  return errors;
}

/* ---------- colour temperature (visual approximation only) ---------- */

/** Approximate sRGB (0–1) of a blackbody at `kelvin` (Tanner Helland fit). Visual only, not colorimetric. */
export function cctToRgb(kelvin) {
  const t = clamp(kelvin, 1000, 40000) / 100;
  let r, g, b;
  if (t <= 66) { r = 255; g = 99.4708025861 * Math.log(t) - 161.1195681661; }
  else { r = 329.698727446 * Math.pow(t - 60, -0.1332047592); g = 288.1221695283 * Math.pow(t - 60, -0.0755148492); }
  if (t >= 66) b = 255; else if (t <= 19) b = 0; else b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  return [r, g, b].map(v => clamp(v, 0, 255) / 255);
}
