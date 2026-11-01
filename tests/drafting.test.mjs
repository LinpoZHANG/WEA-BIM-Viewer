// Run: node --test tests/drafting.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../web/lighting/draft/geom2d.js';
import { planCut, ceilingEdges, gridLines } from '../web/lighting/draft/references.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);
const nearP = (p, q, eps = 1e-9) => { near(p[0], q[0], eps); near(p[1], q[1], eps); };
const seg = (a, b, kind = 'wall') => ({ a, b, kind });
// 4 × 3 m room, walls as single segments
const room = [seg([0, 0], [4, 0]), seg([4, 0], [4, 3]), seg([4, 3], [0, 3]), seg([0, 3], [0, 0])];

test('segment intersection, perpendicular foot, ray distance', () => {
  nearP(G.segmentIntersection([0, 0], [2, 2], [0, 2], [2, 0]), [1, 1]);
  assert.equal(G.segmentIntersection([0, 0], [1, 0], [0, 1], [1, 1]), null);           // parallel
  assert.equal(G.segmentIntersection([0, 0], [1, 0], [2, -1], [2, 1]), null);          // beyond the end
  const c = G.closestOnSegment([1, 5], [0, 0], [4, 0]); nearP(c.point, [1, 0]); near(c.d, 5);
  near(G.rayDistance([1, 1], [1, 0], [4, 0], [4, 3]), 3);
  assert.equal(G.rayDistance([1, 1], [-1, 0], [4, 0], [4, 3]), null);
});

test('mergeSegments joins collinear pieces from a triangle-by-triangle cut', () => {
  const pieces = [seg([0, 0], [1, 0]), seg([1, 0], [2.5, 0]), seg([2.5, 0], [4, 0]), seg([4, 0], [4, 3]), seg([3, 0], [2, 0])];
  const m = G.mergeSegments(pieces);
  assert.equal(m.length, 2);
  const h = m.find(s => Math.abs(s.a[1]) < 1e-9 && Math.abs(s.b[1]) < 1e-9);
  near(Math.min(h.a[0], h.b[0]), 0, 1e-6); near(Math.max(h.a[0], h.b[0]), 4, 1e-6);
  // a gap larger than the tolerance stays split
  assert.equal(G.mergeSegments([seg([0, 0], [1, 0]), seg([1.1, 0], [2, 0])]).length, 2);
});

test('snapping: endpoint > midpoint, intersection, perpendicular, tracking, grid, ortho', () => {
  const index = new G.SegmentIndex(room, 1), tol = 0.1, modes = {};
  const snap = (p, extra = {}) => G.snapPoint(p, { index, origin: [0, 0], ...extra }, { tol, step: 0.05, modes, ...extra.opt });
  let s = snap([3.96, 0.03]); assert.equal(s.kind, 'end'); nearP(s.point, [4, 0]);
  s = snap([2.02, 0.04]); assert.equal(s.kind, 'mid'); nearP(s.point, [2, 0]);
  s = snap([1.3, 2.96], { base: [1.3, 1] }); assert.equal(s.kind, 'perp'); nearP(s.point, [1.3, 3]);
  // alignment with an existing fixture at (1.2, 1.5): x locks, y follows the 50 mm module
  s = snap([1.23, 2.212], { tracks: [{ p: [1.2, 1.5] }] }); assert.equal(s.kind, 'track'); nearP(s.point, [1.2, 2.2], 1e-9);
  assert.equal(s.guides.length, 1);
  // two alignments -> their crossing
  s = snap([2.03, 1.54], { tracks: [{ p: [2, 0.6] }, { p: [3.2, 1.5] }] }); assert.equal(s.kind, 'track2'); nearP(s.point, [2, 1.5]);
  // nothing near: module grid relative to the origin
  s = G.snapPoint([1.234, 1.876], { index, origin: [0.01, 0.02] }, { tol, step: 0.1, modes }); assert.equal(s.kind, 'grid'); nearP(s.point, [1.21, 1.92], 1e-9);
  // ortho from a base point
  s = G.snapPoint([2.6, 1.13], { index, origin: [0, 0] }, { tol, step: 0, ortho: true, modes });
  assert.equal(s.kind, 'free');                                 // no base: ortho does nothing
  s = G.snapPoint([2.6, 1.13], { index, base: [1, 1], origin: [0, 0] }, { tol, step: 0, ortho: true, modes }); nearP(s.point, [2.6, 1]);
  // intersection of crossing references (axis through a wall)
  const idx2 = new G.SegmentIndex([...room, seg([2.5, -1], [2.5, 4], 'axis')], 1);
  s = G.snapPoint([2.53, 0.04], { index: idx2 }, { tol, step: 0, modes }); assert.equal(s.kind, 'int'); nearP(s.point, [2.5, 0]);
  // a disabled snap mode is skipped
  s = G.snapPoint([3.96, 0.03], { index }, { tol, step: 0, modes: { end: false, near: false } }); assert.notEqual(s.kind, 'end');
});

test('temporary dimensions measure to the nearest reference in each direction', () => {
  const inner = [...room, seg([3.4, 0.5], [3.4, 2.5], 'ceiling')];
  const c = G.clearances([1.2, 0.8], inner);
  near(c.left.d, 1.2); near(c.right.d, 2.2); near(c.down.d, 0.8); near(c.up.d, 2.2);
  // editing the left dimension to 600 mm moves the point 0.6 m right of the wall: p + dir·(d − value)
  const moved = G.add([1.2, 0.8], G.mul(G.DIRS.left, c.left.d - 0.6)); nearP(moved, [0.6, 0.8]);
});

test('divide: luminaire spacing rules', () => {
  const half = G.divide([0, 0], [6, 0], 3, 'half').map(p => p[0]);    // spacing 2, ends 1
  half.forEach((x, i) => near(x, [1, 3, 5][i]));
  G.divide([0, 0], [6, 0], 2, 'equal').forEach((p, i) => near(p[0], [2, 4][i]));
  G.divide([0, 0], [6, 0], 4, 'ends').forEach((p, i) => near(p[0], [0, 2, 4, 6][i]));
  G.divide([0, 0], [6, 0], 3, 'margin', 0.6).forEach((p, i) => near(p[0], [0.6, 3, 5.4][i]));
  near(G.divide([0, 0], [0, 4], 1)[0][1], 2);
});

test('command-line coordinates (mm)', () => {
  assert.deepEqual(G.parseCoordinate('1200,600'), { relative: false, value: [1.2, 0.6] });
  assert.deepEqual(G.parseCoordinate('@-300，0'), { relative: true, value: [-0.3, 0] });
  const p = G.parseCoordinate('@1000<90'); assert.equal(p.relative, true); near(p.value[0], 0, 1e-12); near(p.value[1], 1);
  assert.deepEqual(G.parseCoordinate('600'), { distance: 0.6 });
  assert.equal(G.parseCoordinate('abc'), null);
  assert.equal(G.mm(0.59999), '600');
});

// ---- reference extraction on synthetic geometry (view coords: x, y = IFC z, z = −IFC y) ----
function box(x0, y0, z0, x1, y1, z1) {                      // closed box, outward CCW triangles, IFC local coords
  const v = (x, y, z) => [x, z, -y];
  const c = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]].map(p => v(...p));
  const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
  return quads.flatMap(([a, b, cc, d]) => [c[a], c[b], c[cc], c[a], c[cc], c[d]]);
}
function geometry(parts) {
  const pos = [], el = [];
  parts.forEach((vs, k) => vs.forEach(p => { pos.push(...p); el.push(k); }));
  const n = el.length;
  return { position: Float32Array.from(pos), element: Uint32Array.from(el), cover: new Uint32Array(n), vertices: n, opaqueVertices: n };
}
const viewBBox = (x0, y0, z0, x1, y1, z1) => [x0, z0, -y1, x1, z1, -y0];

test('plan cut of walls at +1.2 m and ceiling outlines from down-facing faces', () => {
  const parts = [box(0, 0, 0, 4, 0.2, 2.8), box(0, 0, 2.6, 4, 3, 2.8), box(0, 0, 2.4, 1, 3, 2.6)];
  const elements = [
    { category: 1, discipline: 'ARCH', bbox: viewBBox(0, 0, 0, 4, 0.2, 2.8) },             // wall
    { category: 0, discipline: 'ARCH', bbox: viewBBox(0, 0, 2.6, 4, 3, 2.8) },             // ceiling board
    { category: 0, discipline: 'ARCH', bbox: viewBBox(0, 0, 2.4, 1, 3, 2.6) },             // lowered bulkhead 1 m wide
  ];
  const g = geometry(parts);
  const cut = planCut(g, elements, { z: 1.2 });
  assert.equal(cut.length, 4);                                    // wall rectangle: 2 faces + 2 ends
  assert.ok(cut.every(s => s.kind === 'wall'));
  const faces = cut.filter(s => Math.abs(s.a[1] - s.b[1]) < 1e-6).map(s => s.a[1]).sort();
  near(faces[0], 0, 1e-6); near(faces[1], 0.2, 1e-6);
  const ceil = ceilingEdges(g, elements, { zmin: 2.0, zmax: 3.0 });
  // the bulkhead underside (z 2.4) outlines a 1 × 3 rectangle; the board underside (z 2.6) a 4 × 3 one; the wall
  // underside is at z 0 (out of range); horizontal x = 1 edge of the step must be present
  assert.ok(ceil.some(s => Math.abs(s.a[0] - 1) < 1e-6 && Math.abs(s.b[0] - 1) < 1e-6), 'ceiling step edge at x = 1');
  assert.ok(ceil.every(s => s.kind === 'ceiling'));
  // triangulation diagonals are interior edges, never reported
  assert.ok(!ceil.some(s => Math.abs(s.a[0] - s.b[0]) > 1e-6 && Math.abs(s.a[1] - s.b[1]) > 1e-6));
  // MEP and spaces are ignored
  elements[0].discipline = 'MEP'; assert.equal(planCut(g, elements, { z: 1.2 }).length, 0);
});

test('grid axes: storey filter and duplicate removal', () => {
  const grids = [
    { name: 'G1', storey: '1F', axes: [{ tag: 'A', points: [[0, 0], [10, 0]] }, { tag: '1', points: [[0, -1], [0, 8]] }] },
    { name: 'G1 copy', storey: '1F', axes: [{ tag: 'A', points: [[10, 0], [0, 0]] }] },
    { name: 'G2', storey: '2F', axes: [{ tag: 'B', points: [[0, 5], [10, 5]] }] },
  ];
  const l = gridLines(grids, '1F');
  assert.equal(l.length, 2); assert.deepEqual(l.map(s => s.label).sort(), ['1', 'A']);
  assert.equal(gridLines(grids, null).length, 3);
});

test('interior envelope sample points: inside the room, clear of walls, two heights', async () => {
  const { samplePoints } = await import('../web/lighting/envelope.js');
  const L = { footprint: [[0, 0], [6, 0], [6, 2], [2, 2], [2, 5], [0, 5]], holes: [], min: [0, 0], max: [6, 5], floor: 0, ceiling: 2.6 };
  const pts = samplePoints([L], { perRoom: 4 });
  assert.ok(pts.length >= 4 && pts.length % 2 === 0);
  const { inPolygon } = await import('../web/lighting/photometry.js');
  for (const [x, y, z] of pts) { assert.ok(inPolygon(x, y, L.footprint)); assert.ok(z === 1.2 || Math.abs(z - 2.25) < 1e-9); }
  const tiny = { footprint: [[0, 0], [0.5, 0], [0.5, 0.5], [0, 0.5]], min: [0, 0], max: [0.5, 0.5], floor: 0, ceiling: null };
  assert.equal(samplePoints([tiny]).length, 2, 'narrow room: its centre');
});
