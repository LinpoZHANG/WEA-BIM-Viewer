// Run: node --test tests/lighting.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../web/lighting/photometry.js';
import { makeFrames } from '../web/lighting/coords.js';
import { createFixture } from '../web/lighting/catalog.js';
import { solarPosition, northRotation, sunVector } from '../web/lighting/sun.js';

const near = (a, b, rel = 1e-6, msg) => assert.ok(Math.abs(a - b) <= rel * Math.max(1, Math.abs(b)), msg ?? `${a} ≈ ${b}`);
const fx = (type, over = {}) => {
  const f = createFixture(type, { roomId: 'R', position: [0, 0, 3] });
  Object.assign(f.photometricParameters, over.ph || {}); Object.assign(f.rotation, over.rot || {});
  return f;
};
const down = [0, 0, -1], up = [0, 0, 1];

test('beam angle is the full width at half maximum', () => {
  for (const beam of [10, 24, 36, 60, 90, 120]) {
    const m = P.exponentForBeam(beam);
    near(Math.pow(Math.cos(beam / 2 * Math.PI / 180), m), 0.5, 1e-9, `beam ${beam}`);
  }
  near(P.exponentForBeam(120), 1, 1e-9, '120° FWHM is Lambertian');
});

test('flux is conserved: integral of I over the sphere equals the luminous flux', () => {
  for (const beam of [10, 24, 60, 120]) {
    const m = P.exponentForBeam(beam), I0 = P.peakIntensity(1000, m);
    let sum = 0; const N = 20000;
    for (let k = 0; k < N; k++) {                       // ∫ I(θ) 2π sinθ dθ, midpoint rule
      const th = (k + 0.5) / N * Math.PI;
      sum += P.intensityAt(I0, m, Math.cos(th)) * 2 * Math.PI * Math.sin(th) * Math.PI / N;
    }
    near(sum, 1000, 2e-3, `beam ${beam}: ${sum.toFixed(2)} lm`);
  }
});

test('lumens are not used as candela', () => {
  const m = P.exponentForBeam(60), I0 = P.peakIntensity(600, m);
  assert.notEqual(I0, 600);
  near(I0, 600 * (m + 1) / (2 * Math.PI));
});

test('inverse square law on axis', () => {
  const e = P.fixtureEmitters(fx('downlight'), [0, 0, 3]);
  const E1 = P.illuminanceAt([0, 0, 1], up, e), E2 = P.illuminanceAt([0, 0, -1], up, e);   // r = 2 m, 4 m
  near(E1 / E2, 4, 1e-9);
  near(E1, e[0].I0 / 4, 1e-9, 'E = I0 / r² straight below');
});

test('cosine of incidence', () => {
  const e = P.fixtureEmitters(fx('downlight'), [0, 0, 3]);
  const tilted = [Math.sin(Math.PI / 3), 0, Math.cos(Math.PI / 3)];          // plane tilted 60°
  near(P.illuminanceAt([0, 0, 1], tilted, e) / P.illuminanceAt([0, 0, 1], up, e), 0.5, 1e-9);
  assert.equal(P.illuminanceAt([0, 0, 1], down, e), 0, 'surface facing away receives nothing');
});

test('off-axis points receive less, behind the fixture nothing', () => {
  const f = fx('spotlight', { ph: { beamAngle: 24 }, rot: { aimTilt: 0 } }), e = P.fixtureEmitters(f, [0, 0, 3]);   // catalogue spot defaults to 30° tilt
  const onAxis = P.illuminanceAt([0, 0, 0], up, e);
  const atHalfBeam = P.illuminanceAt([3 * Math.tan(12 * Math.PI / 180), 0, 0], up, e);
  const far = P.illuminanceAt([2, 0, 0], up, e);
  assert.ok(atHalfBeam < onAxis && far < atHalfBeam, `${onAxis} > ${atHalfBeam} > ${far}`);
  // at the half-beam angle intensity is 50 %, then distance and incidence reduce E further by cos³
  const c = Math.cos(12 * Math.PI / 180);
  near(atHalfBeam / onAxis, 0.5 * c ** 3, 1e-9);
  assert.equal(P.illuminanceAt([0, 0, 4], up, e), 0, 'above a downward fixture');
});

test('aiming the spot away lowers illuminance at the target point', () => {
  const p = [0, 0, 0];
  const aimed = P.illuminanceAt(p, up, P.fixtureEmitters(fx('spotlight', { rot: { aimTilt: 0 } }), [0, 0, 3]));
  const away = P.illuminanceAt(p, up, P.fixtureEmitters(fx('spotlight', { rot: { aimTilt: 40, aimAzimuth: 0 } }), [0, 0, 3]));
  assert.ok(away < 0.2 * aimed, `${away} << ${aimed}`);
});

test('contributions of several fixtures add up; switched off contributes zero; dimming scales', () => {
  const p = [0.3, 0.2, 0.8];
  const a = P.fixtureEmitters(fx('downlight'), [0, 0, 2.8]), b = P.fixtureEmitters(fx('downlight'), [1, 0, 2.8]);
  const Ea = P.illuminanceAt(p, up, a), Eb = P.illuminanceAt(p, up, b);
  near(P.illuminanceAt(p, up, [...a, ...b]), Ea + Eb, 1e-12);
  near(P.illuminanceAt(p, up, [...a, ...a]), 2 * Ea, 1e-12, 'identical fixtures double');
  const off = P.fixtureEmitters(fx('downlight', { ph: { on: false } }), [1, 0, 2.8]);
  near(P.illuminanceAt(p, up, [...a, ...off]), Ea, 1e-12);
  const half = P.fixtureEmitters(fx('downlight', { ph: { dimming: 50 } }), [0, 0, 2.8]);
  near(P.illuminanceAt(p, up, half), Ea / 2, 1e-12);
  const moreFlux = P.fixtureEmitters(fx('downlight', { ph: { flux: 1200 } }), [0, 0, 2.8]);
  near(P.illuminanceAt(p, up, moreFlux), 2 * Ea, 1e-12, 'E proportional to flux');
});

test('a narrower beam concentrates light on axis and reduces it at the edge', () => {
  const wide = P.fixtureEmitters(fx('downlight', { ph: { beamAngle: 90 } }), [0, 0, 2.8]);
  const narrow = P.fixtureEmitters(fx('downlight', { ph: { beamAngle: 24 } }), [0, 0, 2.8]);
  assert.ok(P.illuminanceAt([0, 0, 0.8], up, narrow) > P.illuminanceAt([0, 0, 0.8], up, wide));
  assert.ok(P.illuminanceAt([1.5, 0, 0.8], up, narrow) < P.illuminanceAt([1.5, 0, 0.8], up, wide));
});

test('linear fixture: flux conserved over sub-sources and rotation turns its length', () => {
  const f = fx('linear', { ph: { length: 1.2, flux: 900 } });
  const e = P.fixtureEmitters(f, [0, 0, 2.8]);
  assert.equal(e.length, Math.ceil(1.2 / P.LINEAR_SEGMENT));
  near(e.reduce((s, x) => s + x.flux, 0), 900, 1e-12);
  const xs = e.map(x => x.p[0]);
  near(Math.max(...xs) - Math.min(...xs), 1.2 - 1.2 / e.length, 1e-9);
  const r = P.fixtureEmitters(fx('linear', { ph: { length: 1.2 }, rot: { bodyRotation: 90 } }), [0, 0, 2.8]);
  assert.ok(r.every(x => Math.abs(x.p[0]) < 1e-9), 'rotated 90° runs along Y');
});

test('work-plane grid is clipped to the room, holes excluded, stats', () => {
  const L = [[0, 0], [4, 0], [4, 1.5], [1.5, 1.5], [1.5, 4], [0, 4]];        // L-shaped room
  const g = P.workplaneGrid(L, [], 0.8, 0.5);
  assert.ok(g.points.every(([x, y]) => P.inPolygon(x, y, L)));
  assert.ok(!g.points.some(([x, y]) => x > 1.5 && y > 1.5), 'no samples in the missing quadrant');
  near(g.points.length * 0.25, 4 * 1.5 + 1.5 * 2.5, 1e-9, 'sampled area = room area');
  const hole = [[0.5, 0.5], [1, 0.5], [1, 1], [0.5, 1]];
  assert.ok(P.workplaneGrid(L, [hole], 0.8, 0.25).points.every(([x, y]) => !P.inPolygon(x, y, hole)));
  const s = P.illuminanceStats([100, 200, 300]);
  near(s.Eavg, 200); assert.equal(s.Emin, 100); assert.equal(s.Emax, 300); near(s.U0, 0.5);
});

test('percentile for the auto legend', () => {
  near(P.percentile([1, 2, 3, 4, 100], 50), 3);
  near(P.percentile([0, 10], 95), 9.5);
  assert.ok(P.percentile([...Array(99).fill(150), 1041], 95) < 200, 'one hot spot does not set the scale');
});

test('wall border band excludes samples near the walls', () => {
  const sq = [[0, 0], [4, 0], [4, 3], [0, 3]];
  const g = P.workplaneGrid(sq, [], 0.8, 0.25, 0.5);
  assert.ok(g.points.every(([x, y]) => x >= 0.5 && x <= 3.5 && y >= 0.5 && y <= 2.5));
  near(g.points.length * 0.0625, 3 * 2, 1e-9, 'remaining area (4−1)·(3−1)');
});

test('parameter validation', () => {
  assert.deepEqual(P.validateFixture(fx('downlight')), []);
  assert.ok(P.validateFixture(fx('downlight', { ph: { beamAngle: 5 } })).length);
  assert.ok(P.validateFixture(fx('downlight', { ph: { flux: -1 } })).length);
  assert.ok(P.validateFixture(fx('downlight', { ph: { cct: NaN } })).length);
});

test('IFC world <-> local <-> view mapping round-trips and is not an axis swap only', () => {
  const F = makeFrames([500000, 4000000, 0]);
  const w = [500012.5, 4000003.25, 2.7];
  const v = F.worldToView(w);
  assert.deepEqual(v.map(x => +x.toFixed(9)), [12.5, 2.7, -3.25]);
  assert.deepEqual(F.viewToWorld(v).map(x => +x.toFixed(6)), w);
});

test('solar position agrees with Radiance gensky (Beijing, 21 March 10:00 CST)', () => {
  // gensky 3 21 10 +s -a 39.92 -o -116.38 -m -120  ->  altitude 38.3°, azimuth −47.7° (from south, + west)
  const s = solarPosition({ year: 2026, month: 3, day: 21, hour: 10, latitude: 39.9166, longitude: 116.3833, timezone: 8 });
  assert.ok(Math.abs(s.altitude - 38.3) < 1.0, `altitude ${s.altitude}`);
  assert.ok(Math.abs(s.azimuth - (180 - 47.7)) < 1.5, `azimuth ${s.azimuth}`);
  const noon = solarPosition({ year: 2026, month: 6, day: 21, hour: 12.2, latitude: 39.9166, longitude: 116.3833, timezone: 8 });
  assert.ok(Math.abs(noon.altitude - (90 - 39.92 + 23.44)) < 1.5, 'summer solstice noon altitude');
});

test('true north rotation and sun vector', () => {
  near(northRotation([0, 1]), 0);
  near(northRotation([1, 0]), -90, 1e-9, 'north along +X');
  const south = sunVector({ altitude: 30, azimuth: 180 }, 0);
  near(south[1], -Math.cos(Math.PI / 6), 1e-9); near(south[2], 0.5, 1e-9);
  const rotated = sunVector({ altitude: 0, azimuth: 0 }, -90);      // model north along +X
  near(rotated[0], 1, 1e-9);
});

test('luminous surface: patches conserve area and flux, faces by orientation, Lambert intensity', async () => {
  const L = await import('../web/lighting/luminous.js');
  // 2 × 1 m panel at z = 2.6 facing down (two triangles, clockwise from above = normal −z)
  const flat = [0, 0, 2.6, 0, 1, 2.6, 2, 0, 2.6, 2, 0, 2.6, 0, 1, 2.6, 2, 1, 2.6];
  const tris = L.triangles(flat);
  assert.equal(tris.length, 2); assert.ok(tris.every(t => t.n[2] < -0.99));
  assert.equal(L.selectFaces(tris, 'up').length, 0); assert.equal(L.selectFaces(tris, 'down').length, 2);
  assert.equal(L.selectFaces(tris, 'auto', [1, 0.5, 1.2]).length, 2);       // room below: faces toward it
  const pp = L.patches(tris, { size: 0.1 });
  near(pp.area, 2, 1e-9); near(pp.patches.reduce((s, q) => s + q.a, 0), 2, 1e-9);
  const flux = L.fluxFromLuminance(300, pp.area); near(flux, Math.PI * 600, 1e-9); near(L.luminanceFromFlux(flux, 2), 300, 1e-12);
  const em = L.emitters(pp, flux); near(em.reduce((s, e) => s + e.flux, 0), flux, 1e-6);
  // far away it behaves like one Lambertian source: E ≈ I0 / d² with I0 = L·A
  const E = P.illuminanceAt([1, 0.5, 2.6 - 20], [0, 0, 1], em); near(E, 300 * 2 / 400, 0.01);
  // coarsening keeps the patch count bounded
  assert.ok(L.patches(L.triangles([0, 0, 0, 0, 10, 0, 10, 0, 0]), { size: 0.05, maxPatches: 200 }).patches.length <= 200);
  // registry route through photometry.fixtureEmitters, moved by the fixture position
  const f = fx('downlight'); f.fixtureType = 'luminous'; f.fixtureId = 'LUMTEST';
  P.LUMINOUS.set('LUMTEST', { ...pp, origin: [1, 0.5, 2.6] });
  const em2 = P.fixtureEmitters(f, [1, 0.5, 3.6]);   // moved up 1 m
  near(em2.reduce((s, e) => s + e.flux, 0), P.effectiveFlux(f.photometricParameters), 1e-6);
  near(Math.min(...em2.map(e => e.p[2])), 3.6, 1e-9);
  P.LUMINOUS.delete('LUMTEST');
});

test('luminous surface near field matches the analytic rectangle formula (same case as the Radiance test)', async () => {
  const L = await import('../web/lighting/luminous.js');
  const z = 2.5, flat = [0.5, 0.5, z, 0.5, 1, z, 1, 0.5, z, 1, 0.5, z, 0.5, 1, z, 1, 1, z];
  const pp = L.patches(L.triangles(flat), { size: 0.05 }), em = L.emitters(pp, L.fluxFromLuminance(1000, pp.area));
  const h = z - 0.8, x = 0.25 / h, ff = (x, y) => x / Math.sqrt(1 + x * x) * Math.atan(y / Math.sqrt(1 + x * x)) + y / Math.sqrt(1 + y * y) * Math.atan(x / Math.sqrt(1 + y * y));
  const E0 = 1000 * 4 * ff(x, x) / 2, E = P.illuminanceAt([0.75, 0.75, 0.8], [0, 0, 1], em);
  assert.ok(Math.abs(E - E0) / E0 < 0.02, `estimate ${E.toFixed(2)} vs analytic ${E0.toFixed(2)}`);
});

test('luminous surface rotation: turns faces and normals about the centre, keeps area', async () => {
  const LUM = await import('../web/lighting/luminous.js');
  // 1 × 1 m panel at z = 2.5 facing down, centre (0.5, 0.5, 2.5)
  const tris = LUM.triangles([0, 0, 2.5, 0, 1, 2.5, 1, 0, 2.5, 1, 0, 2.5, 0, 1, 2.5, 1, 1, 2.5]);
  const c = [0.5, 0.5, 2.5], s = Math.SQRT1_2;
  const yaw = LUM.rotateTriangles(tris, [0, 0, s, s], c);          // 90° about local Z
  assert.ok(Math.abs(yaw[0].a[0] - 1) < 1e-9 && Math.abs(yaw[0].a[1]) < 1e-9, 'corner (0,0) -> (1,0)');
  assert.ok(Math.abs(yaw[0].n[2] + 1) < 1e-9, 'yaw keeps the downward normal');
  const tilt = LUM.rotateTriangles(tris, [s, 0, 0, s], c);         // 90° about local X: faces now horizontal-facing
  assert.ok(Math.abs(tilt[0].n[1] - 1) < 1e-9 && Math.abs(tilt[0].n[2]) < 1e-9, 'normal -Z -> +Y');
  const A = t => t.reduce((s, x) => s + x.area, 0);
  assert.ok(Math.abs(A(tilt) - 1) < 1e-12 && LUM.rotateTriangles(tris, [0, 0, 0, 1], c) === tris);
  assert.ok(!LUM.isRotated([0, 0, 0, 1]) && LUM.isRotated([0, 0, s, s]));
});
