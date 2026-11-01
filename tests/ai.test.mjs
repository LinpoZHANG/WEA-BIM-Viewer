// Run: node --test tests/ai.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../web/lighting/photometry.js';
import { makeFrames } from '../web/lighting/coords.js';
import { FIXTURE_TYPES, createFixture, mountDrop, newFixtureId } from '../web/lighting/catalog.js';
import { LightingState, emptyDesign, addScheme, newSchemeId } from '../web/lighting/state.js';
import { RoomContext, roomAt, designRooms, isContainerSpace } from '../web/lighting/room.js';
import { roomType, designTargets, checkTargets, parseStyles } from '../web/ai/standards.js';
import { roomWalls, visualCenter, gridLayout, alongWall, aimAt } from '../web/ai/layout.js';
import { classifyObject, roomObjects } from '../web/ai/context.js';
import { DesignTools, TOOL_DEFS } from '../web/ai/tools.js';
import { DesignAgent } from '../web/ai/agent.js';
import { demoProvider, parseRequest } from '../web/ai/providers/demo.js';
import { toOpenAI, fromOpenAI } from '../web/ai/providers/openai.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);

test('pendant: two lobes conserve flux; hangs below the ceiling', () => {
  const f = createFixture('pendant', { position: [0, 0, 2] });
  const em = P.fixtureEmitters(f, [0, 0, 2]);
  assert.equal(em.length, 2);
  near(em[0].flux + em[1].flux, P.effectiveFlux(f.photometricParameters));
  near(em[1].flux / P.effectiveFlux(f.photometricParameters), f.photometricParameters.upRatio);
  assert.deepEqual(em[1].axis, [0, 0, 1]);
  assert.equal(mountDrop(f), f.photometricParameters.suspension);
  assert.deepEqual(P.validateFixture(f), []);
  f.photometricParameters.upRatio = 2; assert.ok(P.validateFixture(f).some(e => e.includes('upRatio')));
});

test('schemes: any number, ids A..Z, copies get new fixture ids', () => {
  const d = emptyDesign({});
  assert.equal(newSchemeId(d), 'C');
  d.schemes.A.fixtures.push(createFixture('downlight', { roomId: 'R' }));
  const id = addScheme(d, { name: 'X', source: 'ai', copyFrom: 'A', newId: newFixtureId });
  assert.equal(id, 'C'); assert.equal(d.schemes.C.source, 'ai');
  assert.notEqual(d.schemes.C.fixtures[0].fixtureId, d.schemes.A.fixtures[0].fixtureId);
});

test('standards: room type, style targets, pass/fail', () => {
  assert.equal(roomType('起居室'), 'living'); assert.equal(roomType('主卧'), 'bedroom'); assert.equal(roomType('储藏'), 'other');
  assert.deepEqual(parseStyles('明亮温馨风格'), ['明亮', '温馨']);
  const t = designTargets('living', ['明亮', '温馨']);
  assert.deepEqual(t.Eavg, [200, 300]); assert.deepEqual(t.cct, [2700, 3000]); assert.equal(t.layered, true);
  assert.equal(checkTargets(t, { Eavg: 250, U0: 0.5, cct: [3000], lpd: 8 }).pass, true);
  const bad = checkTargets(t, { Eavg: 150, U0: 0.2, cct: [4000], lpd: 8 });
  assert.equal(bad.pass, false); assert.equal(bad.items.filter(i => !i.ok).length, 3);
});

const L = [[0, 0], [6, 0], [6, 2], [2, 2], [2, 5], [0, 5]];   // L-shaped room, CCW
test('layout: walls with inward normals, visual centre inside, grid skips outside points, along-wall offset', () => {
  const w = roomWalls(L);
  assert.equal(w.length, 6);
  assert.deepEqual(w[0].inward.map(v => Math.round(v) + 0), [0, 1]); assert.equal(w[0].side, 'S');
  const c = visualCenter(L).point; assert.ok(P.inPolygon(c[0], c[1], L), 'centre inside the L');
  const g = gridLayout({ footprint: L }, 2, 3, { rule: 'half' });
  assert.equal(g.points.length + g.outside.length, 6); assert.ok(g.outside.length >= 1);
  const pts = alongWall(w[0], 3, 0.6);
  pts.forEach((p, i) => { near(p[1], 0.6); near(p[0], [1, 3, 5][i]); });
  const a = aimAt([0, 0, 2.5], [1, 0, 1.5]); near(a.aimTilt, 45); near(a.aimAzimuth, 0);
});

test('object recognition by name, inside the room only', () => {
  assert.equal(classifyObject('L型沙发-01'), 'sofa'); assert.equal(classifyObject('Coffee Table 1200'), 'coffee_table'); assert.equal(classifyObject('SW-040'), null);
  const room = { footprint: [[0, 0], [4, 0], [4, 4], [0, 4]], floor: 0 };
  const els = [{ name: '茶几', category: 0, discipline: 'ARCH', bbox: [1, 0, -3, 2, 0.45, -2] }, { name: '茶几', category: 0, discipline: 'ARCH', bbox: [8, 0, -3, 9, 0.45, -2] }];
  const o = roomObjects(els, room); assert.equal(o.length, 1); assert.deepEqual(o[0].center, [1.5, 2.5]);
});

test('request parsing for the offline demo', () => {
  const r = parseRequest('我要一个明亮温馨风格的客厅，架设八个射灯和一个装饰吊灯');
  assert.deepEqual(r.counts, { spotlight: 8, pendant: 1 }); assert.deepEqual(r.styles, ['明亮', '温馨']); assert.equal(r.roomType, 'living');
  assert.deepEqual(parseRequest('卧室 12 盏筒灯').counts, { downlight: 12 });
  assert.deepEqual(parseRequest('两条灯带，十二个射灯').counts, { linear: 2, spotlight: 12 });
});

test('OpenAI conversion: tools, tool calls and results round-trip', () => {
  const msgs = [{ role: 'system', content: 's' }, { role: 'user', content: 'u' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', name: 'evaluate_scheme', arguments: { scheme_id: 'C', room_id: 'R' } }] },
    { role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' }];
  const o = toOpenAI(msgs, TOOL_DEFS);
  assert.equal(o.tools.length, TOOL_DEFS.length); assert.equal(o.tools[0].type, 'function');
  assert.equal(o.messages[2].tool_calls[0].function.arguments, '{"scheme_id":"C","room_id":"R"}');
  assert.equal(o.messages[3].tool_call_id, 'c1');
  const back = fromOpenAI({ choices: [{ message: { content: null, tool_calls: [{ id: 'x', type: 'function', function: { name: 'layout_grid', arguments: '{"rows":2}' } }, { id: 'y', type: 'function', function: { name: 'f', arguments: '{bad' } }] } }], usage: { prompt_tokens: 10, completion_tokens: 3 } });
  assert.deepEqual(back.tool_calls[0].arguments, { rows: 2 }); assert.ok(back.tool_calls[1].parseError); assert.equal(back.usage.input, 10);
  for (const t of TOOL_DEFS) { assert.equal(t.parameters.type, 'object'); JSON.stringify(t.parameters); }
});

/* ---- whole pipeline in node: agent + offline demo + tools on a stand-in workspace ---- */
function fakeWorkspace() {
  const frames = makeFrames([0, 0, 0]);
  const fp = [[0, 0], [5.85, 0], [5.85, 5.35], [0, 5.35]];
  const el = { guid: 'ROOM-LIVING', id: 1, name: '起居室', category: 7, room: { footprint: fp, holes: [], floor: 0, top: 3, area: 5.85 * 5.35, ceilings: [{ z: 2.5, height: 2.5, coverage: 1, elements: [] }], issues: [] } };
  const rooms = [new RoomContext(el, 0)];
  const state = new LightingState(); state.load(emptyDesign({ name: 'T' }));
  const ws = {
    frames, rooms, room: rooms[0], state, plan: { origin: [0, 0] }, FIXTURE_TYPES,
    v: { elements: [el], model: { name: 'T', schema: 'IFC4', levels: [], project: null } },
    roomById: id => rooms.find(r => r.id === id) || null,
    fixturesIn: r => state.fixtures.filter(f => f.roomId === r.id),
    planPlacement([x, y], type, floor = 0) {
      const room = roomAt(rooms.filter(r => Math.abs(r.floor - floor) < 0.5), x, y);
      if (!room) return { ok: false, reason: '该位置不在任何房间（IfcSpace）范围内' };
      if (!type.mount.includes('ceiling')) return { ok: false, reason: 'wall' };
      return { ok: true, local: [x, y, 2.5 - 0.005], surface: 'ceiling', normal: [0, 0, -1], element: { guid: 'CEIL', id: 9, name: 'ceiling' }, room };
    },
    buildFixture(type, pl, room, { photometry = {}, rotation = {}, name = null, scheme } = {}) {
      const f = createFixture(type, { roomId: room.id, position: [...pl.local] });
      Object.assign(f.photometricParameters, photometry); Object.assign(f.rotation, rotation);
      if (mountDrop(f)) f.position.ifcWorld[2] -= mountDrop(f) - 0.005;
      f.name = name || `${FIXTURE_TYPES[type].code}-${scheme.fixtures.length + 1}`;
      f.mountReference = { kind: 'surface', surface: 'ceiling', status: 'ok' };
      return f;
    },
    updateDerived(f) { f.mountHeight = f.position.ifcWorld[2]; },
  };
  return ws;
}

test('offline demo drives the real tools end to end: three finished draft schemes, existing scheme untouched', async () => {
  const ws = fakeWorkspace(), events = [];
  ws.state.design.schemes.A.fixtures.push(createFixture('downlight', { roomId: 'ROOM-BED', position: [20, 20, 2.5] }));   // a lit room elsewhere in the building
  const before = JSON.stringify(ws.state.design.schemes.A);
  const tools = new DesignTools(ws, { source: 'demo', onEvent: e => events.push(e) });
  const agent = new DesignAgent({ tools, provider: demoProvider() });
  const answer = await agent.send('我要一个明亮温馨风格的客厅，架设八个射灯和一个装饰吊灯');
  const finals = events.filter(e => e.type === 'final');
  assert.equal(finals.length, 3, answer);
  for (const f of finals) {
    const s = ws.state.design.schemes[f.schemeId];
    assert.equal(s.source, 'demo');
    assert.equal(s.fixtures.filter(x => x.fixtureType === 'spotlight').length, 8);
    assert.equal(s.fixtures.filter(x => x.fixtureType === 'pendant').length, 1);
    assert.ok(s.fixtures.every(x => P.validateFixture(x).length === 0));
    assert.ok(s.rationale && s.results['ROOM-LIVING']);
    const pend = s.fixtures.find(x => x.fixtureType === 'pendant');
    near(pend.position.ifcWorld[2], 2.5 - pend.photometricParameters.suspension, 1e-9);
    // positions on the 50 mm module
    for (const x of s.fixtures) for (const k of [0, 1]) near(Math.round(x.position.ifcWorld[k] * 1000) % 50, 0, 1e-6);
  }
  // every scheme reports its outcome honestly; the uniform one reaches the illuminance range and widened the beam
  for (const f of finals) assert.match(ws.state.design.schemes[f.schemeId].rationale, /均达标|未达标/);
  const uni = finals[0].evaluation;
  assert.ok(uni.Eavg >= uni.targets.Eavg[0] && uni.Eavg <= uni.targets.Eavg[1] * 1.15, answer);
  assert.ok(ws.state.design.schemes[finals[0].schemeId].fixtures.filter(x => x.fixtureType === 'spotlight').every(x => x.photometricParameters.beamAngle === 60));
  // layered schemes drop the U0 target explicitly, with a reason
  assert.equal(finals[1].evaluation.targets.U0, null); assert.match(finals[1].evaluation.targets.overrides.reason, /分层/);
  assert.equal(JSON.stringify(ws.state.design.schemes.A), before, 'user scheme untouched');
  // schemes are building-level: fixtures of other rooms in the base scheme are carried into every AI draft
  for (const f of finals) assert.ok(ws.state.design.schemes[f.schemeId].fixtures.some(x => x.fixtureId.startsWith('LF-') && x.roomId === 'ROOM-BED'), 'other room kept');
  assert.match(answer, /离线演示/);
  // the agent cannot write into a scheme it did not create
  const r = await tools.call('place_fixtures', { scheme_id: 'A', room_id: 'ROOM-LIVING', fixtures: [{ type: 'downlight', x_mm: 1000, y_mm: 1000 }] });
  assert.equal(r.ok, false); assert.match(r.error, /不能修改/);
  // invalid parameters are rejected, not clamped
  const id = finals[0].schemeId;
  const bad = await tools.call('update_fixtures', { scheme_id: id, room_id: 'ROOM-LIVING', beam_deg: 500 });
  assert.equal(bad.ok, true); assert.equal(bad.updated.length, 0); assert.ok(bad.errors.length);
  // points outside the room are reported
  const out = await tools.call('place_fixtures', { scheme_id: id, room_id: 'ROOM-LIVING', fixtures: [{ type: 'downlight', x_mm: 9000, y_mm: 1000 }] });
  assert.equal(out.placed.length, 0); assert.match(out.errors[0], /不在任何房间/);
});

test('unsupported free-form requests get an honest answer from the demo', async () => {
  const ws = fakeWorkspace(), tools = new DesignTools(ws, { source: 'demo' });
  const agent = new DesignAgent({ tools, provider: demoProvider() });
  const a = await agent.send('方案二再暖一点');
  assert.match(a, /需要接入大模型/);
});

/* ---- multi-room: "每个房间中心架设一个灯" ---- */
function multiWorkspace() {
  const ws = fakeWorkspace();
  const mk = (guid, name, fp) => new RoomContext({ guid, id: guid.length, name, category: 7, room: { footprint: fp, holes: [], floor: 0, top: 3, area: Math.abs((fp[2][0] - fp[0][0]) * (fp[2][1] - fp[0][1])), ceilings: [{ z: 2.5, height: 2.5, coverage: 1, elements: [] }], issues: [] } }, 0);
  const extra = [mk('ROOM-BED', '主卧', [[6, 0], [10, 0], [10, 4], [6, 4]]), mk('ROOM-CLOSET', '储物', [[10.2, 0], [10.9, 0], [10.9, 0.7], [10.2, 0.7]]),
    mk('UNIT', '户型D', [[-0.1, -0.1], [11, -0.1], [11, 6], [-0.1, 6]])];
  ws.rooms.push(...extra); ws.rooms.sort((a, b) => a.area - b.area);
  return ws;
}

test('ceiling light and room helpers', () => {
  const f = createFixture('ceiling', { position: [0, 0, 2.5] });
  assert.equal(P.fixtureEmitters(f, [0, 0, 2.5]).length, 1); assert.deepEqual(P.validateFixture(f), []); assert.equal(mountDrop(f), 0);
  const ws = multiWorkspace();
  assert.equal(isContainerSpace(ws.rooms, ws.rooms.find(r => r.id === 'UNIT')), true);
  assert.deepEqual(designRooms(ws.rooms).map(r => r.id).sort(), ['ROOM-BED', 'ROOM-LIVING']);   // container and the 0.49 m² closet excluded
});

test('offline demo: one light at the centre of every room, existing lights kept, per-room results', async () => {
  const ws = multiWorkspace(), events = [];
  ws.state.design.schemes.A.fixtures.push(createFixture('downlight', { roomId: 'ROOM-LIVING', position: [1, 1, 2.495] }));
  const tools = new DesignTools(ws, { source: 'demo', onEvent: e => events.push(e) });
  const agent = new DesignAgent({ tools, provider: demoProvider() });
  const answer = await agent.send('每个房间中心架设一个灯');
  const fin = events.find(e => e.type === 'final');
  assert.ok(fin && fin.rooms, answer);
  const s = ws.state.design.schemes[fin.schemeId];
  const ceil = s.fixtures.filter(f => f.fixtureType === 'ceiling');
  assert.deepEqual(ceil.map(f => f.roomId).sort(), ['ROOM-BED', 'ROOM-LIVING']);
  assert.equal(s.fixtures.filter(f => f.fixtureType === 'downlight').length, 1, 'existing living-room light kept');
  const bed = ws.rooms.find(r => r.id === 'ROOM-BED'), c = ceil.find(f => f.roomId === 'ROOM-BED').position.ifcWorld;
  near(c[0], 8, 1e-6); near(c[1], 2, 1e-6);                       // centre of the 4 × 4 bedroom
  assert.equal(fin.rooms.length, 2); assert.match(s.rationale, /2 个房间/);
  assert.match(answer, /离线演示/);
  const two = await new DesignAgent({ tools, provider: demoProvider() }).send('每个房间中心两盏筒灯');
  assert.match(two, /只放 1 盏/);
});
