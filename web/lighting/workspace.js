/* WEA Lighting Design Studio — workspace controller.
 * Reuses the BIM viewer's scene, camera, controls and model through `viewer` (main.js adapter);
 * owns only lighting data and lighting UI. Module map:
 *   photometry.js  distribution, emitters, illuminance, validation (pure, unit-tested)
 *   coords.js      IFC world / IFC local / view frames
 *   catalog.js     generic fixture types          state.js    design document, undo/redo
 *   room.js        room work area (IfcSpace + measured ceilings + manual overrides)
 *   mount.js       CPU check that a fixture still sits on a surface
 *   preview.js     three.js visual preview        heatmap.js  lux false-colour plane
 *   storage.js     save / load / import / export / verification
 *   draft/         2D ceiling-plan positioning: reference lines, snaps, temporary dimensions, typed input
 */
import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { makeFrames } from './coords.js';
import { FIXTURE_TYPES, createFixture, newFixtureId, mountDrop } from './catalog.js';
import { LightingState, emptyDesign, addScheme, SCHEME_SOURCES } from './state.js';
import { roomsFromModel, roomAt, RoomContext, isContainerSpace } from './room.js';
import { MountChecker } from './mount.js';
import { LightingPreview, orientation, rotationFromQuaternion, MAX_SHADOW_LIGHTS, PREVIEW_LIGHT_BUDGET } from './preview.js';
import { IlluminanceHeatmap, LUX_STOPS, niceMax } from './heatmap.js';
import * as P from './photometry.js';
import * as store from './storage.js';
import * as SIM from './simulation.js';
import { DaylightPreview } from './daylight.js';
import { PlanView } from './draft/planview.js';
import * as LUM from './luminous.js';
import { computeEnvelope, loadEnvelope, saveEnvelope, defaultExcludedLayers, layerStats, layersKey } from './envelope.js';
import { roundTo } from './draft/geom2d.js';

/* Luminous rotation: stored as an IFC-local quaternion. View = local turned −90° about X (view Y = local Z). */
const Q_L2V = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
const Q_V2L = Q_L2V.clone().invert();
const lumQuatToView = q => q ? Q_L2V.clone().multiply(new THREE.Quaternion(...q)).multiply(Q_V2L) : new THREE.Quaternion();
const lumQuatFromView = qv => { const q = Q_V2L.clone().multiply(qv).multiply(Q_L2V).normalize(); return q.w < 0 ? [-q.x, -q.y, -q.z, -q.w] : [q.x, q.y, q.z, q.w]; };
const lumEulerDeg = q => { if (!q) return [0, 0, 0]; const e = new THREE.Euler().setFromQuaternion(new THREE.Quaternion(...q), 'ZYX'); return [e.x, e.y, e.z].map(a => Math.round(THREE.MathUtils.radToDeg(a) * 10) / 10 || 0); };
const lumQuatFromEulerDeg = d => { const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(...d.map(THREE.MathUtils.degToRad), 'ZYX')); return [q.x, q.y, q.z, q.w]; };
import { AiPanel } from '../ai/panel.js';

const $ = s => document.querySelector(s);
const r2 = v => Math.round(v * 100) / 100;

export class LightingWorkspace {
  constructor(viewer) {
    this.v = viewer; this.state = new LightingState(); this.active = false; this.ready = false;
    this.tool = 'select'; this.addType = 'downlight'; this.pickFilter = 'fixture'; this.view = 'orbit';
    this.FIXTURE_TYPES = FIXTURE_TYPES; this.LUMINOUS = P.LUMINOUS; this.plan = new PlanView(this); this.ai = new AiPanel(this);
    this.room = null; this.rooms = []; this.contrib = new Map(); this.gridCache = null; this.calcPending = false; this.report = [];
    this.state.addEventListener('change', () => this.onDesignChange());
    this.state.addEventListener('select', () => { this.syncPreview(); this.attachGizmo(); this.renderInspector(); this.renderFixtureList(); if (this.plan.open) { document.querySelector('#ltPlanDimEdit').hidden = true; this.plan.renderFixtures(); this.plan.renderOverlay(); } });
    $('#moduleBim').onclick = () => this.exit();
    $('#moduleLighting').onclick = () => this.enter();
    viewer.events.addEventListener('modelloaded', () => this.init());
    viewer.events.addEventListener('visibility', () => this.active && this.v.invalidateShadows());
    if (viewer.model?.layout && viewer.geometry) this.init();
    this.wireStaticUI();
  }

  /* ---------- lifecycle ---------- */
  async init() {
    const v = this.v, model = v.model;
    this.ready = false; this.contrib.clear(); this.gridCache = null; this.plan.cache.clear(); this.plan.hide(); this.envelope = null;
    this.frames = makeFrames(model.origin);
    this.mount = new MountChecker(v);
    this.preview?.dispose(); this.preview = new LightingPreview(v, this.frames);
    this.heatmap?.clear(); this.heatmap = new IlluminanceHeatmap(v, this.frames);
    this.daylight?.dispose(); this.daylight = new DaylightPreview(v, this.frames); this.sim = null;
    if (!this.tc) {
      this.tc = new TransformControls(v.camera, v.canvas); this.tc.setSize(0.8);
      this.gizmo = this.tc.getHelper(); v.scene.add(this.gizmo); v.pickHidden.push(this.gizmo);
      this.proxy = new THREE.Object3D(); v.scene.add(this.proxy);
      this.tc.addEventListener('dragging-changed', e => { v.controls.enabled = !e.value; this.dragging = e.value; if (!e.value) this.afterTransform(); });
      this.tc.addEventListener('objectChange', () => this.onTransform());
      this.tc.addEventListener('change', () => v.requestRender());
    }
    this.sourceModel = { name: model.name, schema: model.schema, projectGuid: model.project?.guid || null,
      fingerprint: store.modelFingerprint(model), origin: model.origin || [0, 0, 0], unit: 'm' };
    let design = null;
    let migrated = null;
    try { design = await store.loadFromServer(model.name); } catch (err) { v.toast(err.message); }
    if (!design) {                                       // same project exported again / renamed: carry its design over (verified below)
      try { migrated = await store.findForProject(model.project?.guid, model.name); design = migrated?.design || null; } catch (err) { console.warn(err); }
    }
    this.adopt(design || emptyDesign(this.sourceModel), migrated ? `已从同一项目的模型「${migrated.model}」迁移照明方案（保存后存为当前模型）` : design ? '已载入保存的照明方案' : null);
    if (migrated) this.state.dirty = true;
    this.ready = true;
    if (this.active) this.enter(true);
  }
  adopt(design, note) {
    this.rooms = roomsFromModel(this.v.elements, design.roomOverrides);
    this.report = store.verifyDesign(design, this.v.model, { checkMount: f => this.checkMount(f) });
    design.sourceModel = { ...this.sourceModel };
    design.simulationSettings = { ...SIM.defaultSimulationSettings(this.v.model.site), ...(design.simulationSettings || {}) };
    design.elvSettings = { lvVoltage: 24, dropLimit: 3, panelHeight: 1.3, ...(design.elvSettings || {}) };
    design.roomAnnotations ||= {};
    design.designerSettings.envelopeOnly ??= true;
    design.designerSettings.layerExclude ??= defaultExcludedLayers(this.v.elements);
    this.state.load(design); this.state.dirty = false;
    if (note) this.v.toast(note + (this.report.length ? `；${this.report.length} 项需要检查` : ''));
    this._lumKey = new Map(); this.prepareLuminous();
    this.renderRoomSelect(); this.renderScheme(); this.renderReport();
  }
  enter(force = false) {
    if (!this.ready) { this.v.toast('模型尚未载入'); return; }
    if (this.active && !force) return;
    this.active = true; document.body.classList.add('ws-lighting');
    document.querySelectorAll('.sidebar').forEach(el => el.scrollTop = 0);     // lighting panels start at the top
    $('#moduleLighting').classList.add('active'); $('#moduleBim').classList.remove('active'); $('#routingButton')?.classList.remove('active');
    this.v.clickHandler = e => this.onClick(e);
    this.applyDisplay(); this.preview.setEnabled(true); this.syncDaylight();
    if (!this.room) this.selectRoom((this.rooms.find(r => this.fixturesIn(r).length) || [...this.rooms].reverse().find(r => r.area <= 60) || this.rooms[0])?.id, 'orbit');
    else { this.applyRoomFilter(); this.syncPreview(); this.scheduleCalc(); }
    this.renderAll();
    if (this.state.design.designerSettings.envelopeOnly) this.ensureEnvelope();
  }
  exit() {
    if (!this.active) return;
    this.active = false; document.body.classList.remove('ws-lighting');
    document.querySelectorAll('.sidebar').forEach(el => el.scrollTop = 0);
    $('#moduleBim').classList.add('active'); $('#moduleLighting').classList.remove('active');
    this.v.clickHandler = null; this.plan.hide(); this.setTool('select');
    if (this.modeBeforeGlobal) { this.v.setMode(this.modeBeforeGlobal); this.modeBeforeGlobal = null; } this.tc?.detach(); this.ghost && (this.ghost.visible = false);
    this.preview.setEnabled(false); this.heatmap.clear(); this.clearGlobalHeatmaps(); this.clearRoomOutline(); this.daylight?.sync(this.daySettings, null, null, false);
    this.v.setExtraFilter(null); this.v.clearSection(); this.v.setDisplayLighting(true); this.v.requestRender();
  }

  /* ---------- rooms ---------- */
  fixturesIn(room) { return this.state.fixtures.filter(f => f.roomId === room.id); }
  roomById(id) { return this.rooms.find(r => r.id === id) || null; }
  selectRoom(id, view = this.view) {
    this.room = this.roomById(id); if (!this.room) return;
    this.gridCache = null; this.state.select(null);
    this.drawRoomOutline(); this.applyRoomFilter(); this.setView(view); this.syncDaylight();
    this.renderRoomSelect(); this.renderRoomInfo(); this.syncPreview(); this.scheduleCalc(); this.renderFixtureList();
  }
  setView(view) {
    const room = this.room; if (!room) return;
    const wasGlobal = this.view === 'global';
    if (wasGlobal && view !== 'global' && this.modeBeforeGlobal) { this.v.setMode(this.modeBeforeGlobal); this.modeBeforeGlobal = null; }
    this.view = view; const cut = (room.ceiling ?? room.top) - 0.03;
    document.querySelectorAll('[data-lt-view]').forEach(b => b.classList.toggle('active', b.dataset.ltView === view));
    if (view === 'plan') {                      // 2D reflected ceiling plan for precise positioning; 3D stays in top view behind it
      if (wasGlobal) { this.clearGlobalHeatmaps(); this.applyRoomFilter(); this.scheduleCalc(); }
      this.v.setSection(room.floor - 0.3, cut); this.v.focusBBox(room.viewBBox(this.frames), true);
      this.plan.show(room); return;
    }
    this.plan.hide();
    if (view === 'global') {                    // whole building: every storey's fixtures and heat maps, architecture in X-ray
      const bb = this.rooms.map(r => r.viewBBox(this.frames)).reduce((a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2]), Math.max(a[3], b[3]), Math.max(a[4], b[4]), Math.max(a[5], b[5])]);
      if (!wasGlobal) { this.modeBeforeGlobal = this.v.state.mode; this.v.setMode('xray'); }
      this.v.exitPerson(false); this.v.setExtraFilter(this.composeFilter((i, e) => e.discipline !== 'MEP')); this.v.clearSection();   // overview: envelope and no MEP, so nothing covers the lights
      this.v.focusBBox(bb); this.scheduleCalc(); return;
    }
    if (wasGlobal) { this.clearGlobalHeatmaps(); this.applyRoomFilter(); this.scheduleCalc(); }
    if (view === 'person' && room.element.viewpoint) { this.v.clearSection(); this.v.enterPerson(room.element.viewpoint, room.name); return; }
    this.v.setSection(room.floor - 0.3, cut);           // view Y = IFC local Z
    this.v.focusBBox(room.viewBBox(this.frames), view === 'top');
  }
  /** element filter of the lighting views: interior envelope (if on) ∧ the given extra condition */
  composeFilter(extra = null) {
    const env = this.envelopeActive ? this.envelope.keep : null, lay = this.layerFilter(), moved = this.movedLuminous();
    if (!env && !extra && !lay && !moved.size) return null;
    return (i, e) => !moved.has(i) && (!lay || lay(i, e)) && (!env || env.has(i)) && (!extra || extra(i, e));
  }
  /** element indices of luminous fixtures moved away from their BIM element (the moved copy replaces them) */
  movedLuminous() {
    const out = new Set();
    for (const f of this.state.fixtures || []) {
      if (f.fixtureType !== 'luminous') continue;
      const g = P.LUMINOUS.get(f.fixtureId); if (!g) continue;
      const l = this.frames.worldToLocal(f.position.ifcWorld);
      if (g.rotated || Math.hypot(l[0] - g.origin[0], l[1] - g.origin[1], l[2] - g.origin[2]) > 0.001) out.add(g.element);
    }
    return out;
  }
  /** excluded CAD layers (design setting) -> element filter, or null */
  layerFilter() {
    const ex = new Set(this.state.design?.designerSettings.layerExclude || []);
    return ex.size ? (i, e) => !ex.has(e.layer) : null;
  }
  /** element indices passing the lighting filters (for the Radiance request), or null if nothing is filtered */
  allowedElements() {
    const f = this.composeFilter(); if (!f) return null;
    return this.v.elements.map((e, i) => f(i, e) ? i : -1).filter(i => i >= 0);
  }
  get envelopeActive() { return !!(this.state.design?.designerSettings.envelopeOnly && this.envelope); }
  applyRoomFilter() {
    const ds = this.state.design.designerSettings, room = this.room;
    if (!ds.isolateRoom || !room) { this.v.setExtraFilter(this.composeFilter()); return; }
    const b = room.viewBBox(this.frames), m = 0.4;
    this.v.setExtraFilter(this.composeFilter((i, e) => { const x = e.bbox; return !!x && x[0] <= b[3] + m && x[3] >= b[0] - m && x[1] <= b[4] + m && x[4] >= b[1] - m && x[2] <= b[5] + m && x[5] >= b[2] - m; }));
  }
  /** Interior envelope: cached per model, otherwise sampled from the rooms on the GPU (a few seconds, once). */
  async ensureEnvelope(force = false) {
    if (this.envelopeBusy || (!force && this.envelope)) return this.envelope;
    const fp = this.sourceModel?.fingerprint && this.sourceModel.fingerprint + ':' + layersKey(this.state.design.designerSettings.layerExclude || []), els = this.v.elements;
    if (!force && fp) { const c = loadEnvelope(fp, els); if (c) { this.envelope = c; this.afterEnvelope(); return c; } }
    this.envelopeBusy = true; const note = $('#ltEnvelopeNote');
    this.v.setExtraFilter(this.layerFilter());                                             // excluded layers neither seen nor occluding
    const t0 = performance.now();
    try {
      const res = await computeEnvelope(this.v, this.rooms, this.frames, f => { if (note) note.textContent = `正在计算室内外圈… ${Math.round(f * 100)}%`; });
      this.envelope = { keep: res.keep, cached: false, points: res.points, ms: performance.now() - t0 };
      if (fp) saveEnvelope(fp, els, res.keep);
    } catch (err) { console.error(err); this.v.toast('室内外圈计算失败：' + err.message); this.envelope = null; }
    finally { this.envelopeBusy = false; }
    this.afterEnvelope(); return this.envelope;
  }
  afterEnvelope() {
    this.plan.cache.clear(); if (this.plan.open && this.room) this.plan.show(this.room);
    if (this.active) { this.view === 'global' ? this.setView('global') : this.applyRoomFilter(); this.v.invalidateShadows(); }
    this.renderEnvelopeNote();
  }
  renderLayers() {
    const box = $('#ltLayers'); if (!box || !this.state.design) return;
    const ex = new Set(this.state.design.designerSettings.layerExclude || []), stats = layerStats(this.v.elements);
    box.querySelector('summary').textContent = `图层（排除 ${stats.filter(([l]) => ex.has(l)).length} / ${stats.length}）`;
    box.querySelector('.lt-layer-list').innerHTML = stats.map(([l, n]) => `<label class="lt-layer"><input type="checkbox" data-layer="${this.v.safe(l)}" ${ex.has(l) ? '' : 'checked'}><span>${this.v.safe(l)}</span><small>${n}</small></label>`).join('');
    box.querySelectorAll('[data-layer]').forEach(cb => cb.onchange = () => {
      const ds = this.state.design.designerSettings, set = new Set(ds.layerExclude || []);
      cb.checked ? set.delete(cb.dataset.layer) : set.add(cb.dataset.layer);
      ds.layerExclude = [...set].sort(); this.state.dirty = true; this.renderLayers();
      clearTimeout(this._layerT); this._layerT = setTimeout(() => { this.envelope = null; this.applyRoomFilter(); if (ds.envelopeOnly) this.ensureEnvelope(); else this.afterEnvelope(); }, 600);
    });
  }
  renderEnvelopeNote() {
    const el = $('#ltEnvelopeNote'); if (!el) return;
    const e = this.envelope, n = this.v.elements.filter(x => x.bbox && x.category !== 7).length;
    el.textContent = !this.state.design.designerSettings.envelopeOnly ? '显示全部构件（基层、龙骨、饰面后的结构也参与显示与仿真）'
      : !e ? '室内外圈尚未计算' : `室内外圈：保留 ${e.keep.size} / ${n} 个构件，隐藏 ${n - e.keep.size} 个（从任何房间都看不到）${e.cached ? '' : ` · ${e.points} 个采样点 · ${(e.ms / 1000).toFixed(1)} s`}`;
  }
  /** mount surfaces: architecture only, and only the envelope while it is on */
  mountAccept() { const env = this.envelopeActive ? this.envelope.keep : null; return (k, e) => e.category !== 7 && e.discipline !== 'MEP' && (!env || env.has(k)); }
  drawRoomOutline() {
    this.clearRoomOutline(); const room = this.room; if (!room) return;
    const F = this.frames, mk = (z, color, dashed) => {
      const pts = [...room.footprint, room.footprint[0]].map(([x, y]) => new THREE.Vector3(...F.localToView([x, y, z])));
      const g = new THREE.BufferGeometry().setFromPoints(pts);
      const m = dashed ? new THREE.LineDashedMaterial({ color, dashSize: 0.15, gapSize: 0.1, toneMapped: false }) : new THREE.LineBasicMaterial({ color, toneMapped: false });
      const l = new THREE.Line(g, m); if (dashed) l.computeLineDistances(); l.renderOrder = 6; return l;
    };
    this.outline = new THREE.Group();
    this.outline.add(mk(room.floor + 0.015, 0xd7f16b, false));
    if (room.ceiling != null) this.outline.add(mk(room.ceiling - 0.015, 0x8fd0ff, true));
    this.v.scene.add(this.outline); this.v.pickHidden.push(this.outline); this.v.requestRender();
  }
  clearRoomOutline() {
    if (!this.outline) return;
    this.v.scene.remove(this.outline); this.v.pickHidden.splice(this.v.pickHidden.indexOf(this.outline), 1);
    this.outline.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); }); this.outline = null;
  }
  setRoomOverride(patch) {
    const id = this.room.id;
    this.state.commit('room override', d => { d.roomOverrides[id] = { ...(d.roomOverrides[id] || {}), ...patch }; });
    this.rooms = roomsFromModel(this.v.elements, this.state.design.roomOverrides); this.plan.cache.clear();
    this.room = this.roomById(id); this.gridCache = null; this.drawRoomOutline(); this.renderRoomInfo(); this.scheduleCalc();
    if (this.plan.open) this.plan.show(this.room);
  }
  clearRoomOverride() {
    const id = this.room.id;
    this.state.commit('room override', d => { delete d.roomOverrides[id]; });
    this.rooms = roomsFromModel(this.v.elements, this.state.design.roomOverrides); this.plan.cache.clear();
    this.room = this.roomById(id); this.gridCache = null; this.drawRoomOutline(); this.renderRoomInfo(); this.scheduleCalc();
    if (this.plan.open) this.plan.show(this.room);
  }

  /* ---------- tools & placement ---------- */
  setTool(tool) {
    this.tool = tool;
    document.querySelectorAll('[data-lt-tool]').forEach(b => b.classList.toggle('active', b.dataset.ltTool === tool));
    if (this.ghost) this.ghost.visible = false;
    this.v.canvas.style.cursor = tool === 'add' || tool === 'area' ? 'crosshair' : '';
    this.attachGizmo(); this.v.requestRender();
  }
  ensureGhost() {
    if (this.ghost) return this.ghost;
    this.ghost = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.02, 24), new THREE.MeshBasicMaterial({ color: 0x8be36a, transparent: true, opacity: 0.85, toneMapped: false, depthTest: false }));
    this.ghost.renderOrder = 20; this.v.scene.add(this.ghost); this.v.pickHidden.push(this.ghost); return this.ghost;
  }
  /** Evaluate a surface hit for the current fixture type: returns placement or { ok:false, reason } */
  placementFor(hit, typeKey = this.addType) {
    if (!hit || !this.room) return { ok: false, reason: '没有可用表面' };
    const F = this.frames, type = FIXTURE_TYPES[typeKey];
    let nV = hit.normal, local = F.viewToLocal(hit.point.toArray()), element = hit.element, index = hit.index;
    let surface = nV.y < -0.7 ? 'ceiling' : Math.abs(nV.y) < 0.35 ? 'wall' : nV.y > 0.7 ? 'floor' : 'sloped';
    // Cutaway / top views clip the ceiling away: a click on the floor (or a wall, for ceiling-only types)
    // mounts the fixture on the lowest down-facing surface straight above, found by CPU ray cast.
    if (surface !== 'ceiling' && type.mount.includes('ceiling') && (surface !== 'wall' || !type.mount.includes('wall'))) {
      const start = Math.max(local[2], this.room.floor + 1.8);
      const o = F.localToView([local[0], local[1], start]);
      const up = this.mount.raycast(o, [0, 1, 0], 8, this.mountAccept());
      if (!up || up.normal[1] > -0.2 && up.normal[1] < 0.2) return { ok: false, reason: '正上方 8 m 内没有找到天花表面，请在人视中直接点击天花，或手动指定安装面' };
      local = [local[0], local[1], start + up.t]; element = this.v.elements[up.index]; index = up.index;
      nV = new THREE.Vector3(0, -1, 0); surface = 'ceiling';
    }
    const nL = F.dirViewToLocal(nV.toArray());
    if (!type.mount.includes(surface)) return { ok: false, reason: `${type.label}只能装在${type.mount.map(m => m === 'ceiling' ? '天花' : '墙面').join('/')}上（当前：${{ ceiling: '天花', wall: '墙面', floor: '地面', sloped: '斜面' }[surface]}）` };
    if (hit.element?.category === 7) return { ok: false, reason: '这是 IfcSpace 空间体，不是安装面' };
    if (hit.element?.discipline === 'MEP' && surface === 'ceiling') return { ok: false, reason: `${hit.element.name} 是机电构件，不能作为灯具安装面` };
    const snap = this.state.design.designerSettings.snap ? this.state.design.designerSettings.snapStep : 0;
    const offset = surface === 'ceiling' ? 0.005 : 0.08;
    let p = local.map((c, k) => c + nL[k] * offset);
    if (snap) {                                   // module grid from the positioning origin (same as the plan view)
      const o = this.plan.origin;
      if (surface === 'ceiling') { p[0] = roundTo(p[0], snap, o[0]); p[1] = roundTo(p[1], snap, o[1]); }
      else p[2] = this.room.floor + Math.round((p[2] - this.room.floor) / snap) * snap;
    }
    if (!this.room.contains(p[0], p[1], 0.06)) return { ok: false, reason: `不在当前房间「${this.room.name}」范围内` };
    return { ok: true, local: p, surface, normal: nL, element, index };
  }
  onPointerMove(e) {
    if (!this.active || (this.tool !== 'add' && this.tool !== 'area') || this.dragging) return;
    this._hoverEvent = e;
    if (this._hoverQueued) return; this._hoverQueued = true;
    requestAnimationFrame(() => {
      this._hoverQueued = false; const ev = this._hoverEvent;
      const hit = this.v.pickSurface(ev.clientX, ev.clientY), g = this.ensureGhost();
      if (this.tool === 'area') { g.visible = !!hit; if (hit) { g.position.copy(hit.point); g.material.color.set(0x8fd0ff); } this.v.requestRender(); return; }
      const pl = this.placementFor(hit);
      g.visible = !!hit;
      if (hit) {
        const p = pl.ok ? this.frames.localToView(pl.local) : hit.point.toArray();
        g.position.set(...p); g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), pl.ok ? new THREE.Vector3(...this.frames.dirLocalToView(pl.normal)) : hit.normal);
        g.material.color.set(pl.ok ? 0x8be36a : 0xe8553a);
      }
      $('#ltHint').textContent = pl.ok ? `单击放置 ${FIXTURE_TYPES[this.addType].label} · 安装高度 ${r2(pl.local[2] - this.room.floor)} m` : (pl.reason || '');
      this.v.requestRender();
    });
  }
  onClick(e) {
    if (!this.active) return false;
    if (this.tc?.axis || this.dragging) return true;
    if (this.tool === 'add') { this.addAt(e); return true; }
    if (this.tool === 'area') { this.areaClick(e); return true; }
    if (this.pickFilter === 'bim') { setTimeout(() => this.renderInspector(), 0); return false; }   // default BIM selection
    const id = this.pickFixture(e);
    this.state.select(id);
    return true;
  }
  pickFixture(e) {
    const r = this.v.canvas.getBoundingClientRect(), ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1), this.v.camera);
    const hits = ray.intersectObjects(this.preview.bodies.children, false);
    if (hits.length) return hits[0].object.userData.fixtureId;
    // generous screen-space fallback: nearest fixture body within 14 px
    let best = null, bestD = 14;
    for (const m of this.preview.bodies.children) {
      const s = m.position.clone().project(this.v.camera);
      if (s.z > 1) continue;
      const d = Math.hypot((s.x + 1) / 2 * r.width - (e.clientX - r.left), (1 - s.y) / 2 * r.height - (e.clientY - r.top));
      if (d < bestD) { bestD = d; best = m.userData.fixtureId; }
    }
    return best;
  }
  addAt(e) {
    const pl = this.placementFor(this.v.pickSurface(e.clientX, e.clientY));
    if (!pl.ok) { this.v.toast(pl.reason); return; }
    this.createAt(pl, this.room);
  }
  /** Ceiling mount point straight above a plan point (IFC local x, y): the room containing it on the
   *  current storey, and the lowest down-facing architectural surface above (CPU ray cast). */
  planPlacement([x, y], type = FIXTURE_TYPES[this.addType], floor = this.room.floor) {
    const storey = this.rooms.filter(r => Math.abs(r.floor - floor) < 0.5);
    const room = roomAt(storey, x, y);
    if (!room) return { ok: false, reason: '该位置不在任何房间（IfcSpace）范围内' };
    if (!type.mount.includes('ceiling')) return { ok: false, reason: `${type.label}为墙装灯具，请在 3D 视图中点击墙面放置` };
    const start = room.floor + 1.8;
    const up = this.mount.raycast(this.frames.localToView([x, y, start]), [0, 1, 0], 8, this.mountAccept());
    if (!up || up.normal[1] > -0.2 && up.normal[1] < 0.2) return { ok: false, reason: '正上方 8 m 内没有找到天花表面' };
    const element = this.v.elements[up.index];
    return { ok: true, local: [x, y, start + up.t - 0.005], surface: 'ceiling', normal: [0, 0, -1], element, index: up.index, room };
  }
  addFixtureAtPlan(pt) {
    const pl = this.planPlacement(pt);
    if (!pl.ok) { this.v.toast(pl.reason); return false; }
    this.createAt(pl, pl.room); return true;
  }
  /** Move a fixture to a plan point; ceiling fixtures re-mount on the ceiling found there (ceiling steps). */
  moveFixtureToPlan(id, [x, y]) {
    const f = this.state.fixture(id); if (!f) return false;
    if (f.fixtureType === 'luminous') { this.moveLuminous(id, [x, y]); return true; }
    const type = FIXTURE_TYPES[f.fixtureType], local = this.frames.worldToLocal(f.position.ifcWorld);
    const ceilingMount = (f.mountReference?.surface || (type.mount.includes('ceiling') ? 'ceiling' : 'wall')) === 'ceiling';
    let z = local[2], room = this.roomById(f.roomId), mr = f.mountReference;
    if (ceilingMount) {
      const pl = this.planPlacement([x, y], type);
      if (!pl.ok) { this.v.toast('未移动：' + pl.reason); return false; }
      z = pl.local[2] - (mountDrop(f) ? mountDrop(f) - 0.005 : 0); room = pl.room;
      mr = { ...(mr || {}), kind: 'surface', surface: 'ceiling', elementGuid: pl.element?.guid || null, elementId: pl.element?.id ?? null, elementName: pl.element?.name || '', normal: [0, 0, -1], status: 'ok', message: '平面定位' };
    } else {
      const storey = this.rooms.filter(r => Math.abs(r.floor - (room?.floor ?? this.room.floor)) < 0.5);
      room = roomAt(storey, x, y) || room;
    }
    const w = this.frames.localToWorld([x, y, z]);
    this.state.commit('move', d => {
      const q = d.schemes[d.activeScheme].fixtures.find(o => o.fixtureId === id);
      q.position.ifcWorld = w; q.mountReference = mr ? JSON.parse(JSON.stringify(mr)) : q.mountReference;
      if (room) { q.roomId = room.id; q.roomExpressId = room.expressId; }
      if (!ceilingMount) { const res = this.checkMount(q); q.mountReference = { ...q.mountReference, status: res.ok ? 'ok' : 'invalid', message: res.message }; }
      this.updateDerived(q);
    });
    return true;
  }
  createAt(pl, room, select = true) {
    const f = this.buildFixture(this.addType, pl, room);
    this.state.commit('add fixture', d => d.schemes[d.activeScheme].fixtures.push(f));
    if (select) this.state.select(f.fixtureId);
    return f;
  }
  /** New fixture object at a placement (planPlacement / placementFor result); pendants hang below the ceiling point. */
  buildFixture(type, pl, room, { photometry = {}, rotation = {}, name = null, scheme = this.state.scheme } = {}) {
    const local = [...pl.local];
    const f = createFixture(type, { roomId: room.id, roomExpressId: room.expressId, ifcProjectId: this.v.model.project?.guid || null,
      position: this.frames.localToWorld(local), mountHeight: r2(local[2] - room.floor) });
    Object.assign(f.photometricParameters, photometry); Object.assign(f.rotation, rotation);
    const drop = mountDrop(f);
    if (drop) { local[2] -= drop - 0.005; f.position.ifcWorld = this.frames.localToWorld(local); }
    f.name = name || `${FIXTURE_TYPES[type].code}-${String(scheme.fixtures.filter(x => x.fixtureType === type).length + 1).padStart(2, '0')}`;
    f.mountReference = { kind: 'surface', surface: pl.surface, elementGuid: pl.element?.guid || null, elementId: pl.element?.id ?? null,
      elementName: pl.element?.name || '', normal: pl.normal.map(r2), status: 'ok', message: '放置时拾取' };
    if (pl.surface === 'wall' && rotation.aimTilt === undefined) { f.rotation.aimTilt = 55; f.rotation.aimAzimuth = r2(Math.atan2(pl.normal[1], pl.normal[0]) * 180 / Math.PI); }
    this.updateDerived(f);
    return f;
  }
  areaClick(e) {
    const hit = this.v.pickSurface(e.clientX, e.clientY); if (!hit) return;
    const p = this.frames.viewToLocal(hit.point.toArray());
    if (!this._areaStart) { this._areaStart = p; $('#ltHint').textContent = '已记录第一角，再点击对角'; return; }
    const a = this._areaStart; this._areaStart = null;
    const fp = [[a[0], a[1]], [p[0], a[1]], [p[0], p[1]], [a[0], p[1]]];
    if (Math.abs(p[0] - a[0]) < 0.3 || Math.abs(p[1] - a[1]) < 0.3) { this.v.toast('区域过小'); return; }
    this.setRoomOverride({ footprint: fp, confirmed: true }); this.setTool('select'); this.v.toast('已设为手动矩形工作区域');
  }
  updateDerived(f) {
    const local = this.frames.worldToLocal(f.position.ifcWorld), room = this.roomById(f.roomId);
    f.position.roomLocal = room ? room.localToRoom(local).map(v => Math.round(v * 1000) / 1000) : null;
    f.mountHeight = room ? r2(local[2] - room.floor) : f.mountHeight;
    f.position.ifcWorld = f.position.ifcWorld.map(v => Math.round(v * 1e5) / 1e5);
  }
  checkMount(f) {
    const mr = f.mountReference || {};
    if (mr.kind === 'element') { const e = this.v.elements.find(x => x.guid === mr.elementGuid); return e ? { ok: true, message: `发光构件 ${e.name}` } : { ok: false, message: '赋值为发光体的构件在当前模型中不存在' }; }
    if (mr.kind !== 'surface') return { ok: true, message: '手动定位' };
    const F = this.frames, local = F.worldToLocal(f.position.ifcWorld), n = mr.normal || [0, 0, -1];
    const o = F.localToView(local.map((c, k) => c + n[k] * 0.02)), d = F.dirLocalToView(n.map(c => -c));
    // fixtures sit 5 mm (ceiling) / 80 mm (wall) off their surface; search a little beyond that only
    const reach = (mr.surface === 'wall' ? 0.08 : mountDrop(f) || 0.005) + 0.06;
    const hit = this.mount.raycast(o, d, reach + 0.02, this.mountAccept());
    if (!hit) return { ok: false, message: `原安装面不存在（${Math.round(reach * 100)} cm 内无建筑表面），位置未改动，请人工确认` };
    const e = this.v.elements[hit.index];
    if (mr.elementGuid && e.guid !== mr.elementGuid) { mr.elementGuid = e.guid; mr.elementId = e.id; mr.elementName = e.name; return { ok: true, message: `安装面已更新为 ${e.name}` }; }
    return { ok: true, message: `安装于 ${e.name}` };
  }

  /* ---------- direct drag in 3D ---------- */
  dragStart(e) {
    if (!this.active || e.button !== 0 || this.pickFilter !== 'fixture' || !(this.tool === 'select' || this.tool === 'move') || this.tc?.axis) return;
    const id = this.pickFixture(e), f = id && this.state.fixture(id);
    if (!f) return;
    this.v.controls.enabled = false;                    // OrbitControls ignores this press
    this._drag = { id, x: e.clientX, y: e.clientY, moved: false };
    if (f.fixtureType === 'luminous') {                 // luminous surface: slides horizontally at its own height
      const l = this.frames.worldToLocal(f.position.ifcWorld), hit = this.rayToHeight(e, l[2]);
      this._drag.plane = l[2]; this._drag.grab = hit ? [l[0] - hit[0], l[1] - hit[1]] : [0, 0];
    }
  }
  dragMove(e) {
    const d = this._drag; if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4) return;
    if (!d.moved) { d.moved = true; this.dragging = true; this.preview.suspendShadows = true; this.state.select(d.id); this.v.canvas.style.cursor = 'grabbing'; }
    d.ev = e; if (d.queued) return; d.queued = true;
    requestAnimationFrame(() => {
      d.queued = false; if (!this._drag) return;
      const f = this.state.fixture(d.id); if (!f) return;
      if (f.fixtureType === 'luminous') {
        const hit = this.rayToHeight(d.ev, d.plane); if (!hit) return;
        const o = this.plan.origin, step = this.state.design.designerSettings.snap ? this.state.design.designerSettings.snapStep : 0;
        let p = [hit[0] + d.grab[0], hit[1] + d.grab[1]];
        if (step) p = [roundTo(p[0], step, o[0]), roundTo(p[1], step, o[1])];
        this.moveLuminous(d.id, p, 'drag:' + d.id);
        const g = P.LUMINOUS.get(d.id), l = this.frames.worldToLocal(this.state.fixture(d.id).position.ifcWorld);
        $('#ltHint').textContent = `拖动 ${f.name} · 偏移 ΔX ${Math.round((l[0] - g.origin[0]) * 1000)} · ΔY ${Math.round((l[1] - g.origin[1]) * 1000)} mm（原构件在照明模式中隐藏）`;
        return;
      }
      const pl = this.placementFor(this.v.pickSurface(d.ev.clientX, d.ev.clientY), f.fixtureType);
      if (!pl.ok) { $('#ltHint').textContent = pl.reason; return; }
      const drop = mountDrop(f), local = [...pl.local]; if (drop) local[2] -= drop - 0.005;
      const storey = this.rooms.filter(r => Math.abs(r.floor - (this.roomById(f.roomId)?.floor ?? this.room.floor)) < 0.5);
      const room = roomAt(storey, local[0], local[1]) || this.roomById(f.roomId);
      this.state.commit('drag', dd => {
        const x = dd.schemes[dd.activeScheme].fixtures.find(q => q.fixtureId === d.id);
        x.position.ifcWorld = this.frames.localToWorld(local);
        x.mountReference = { ...(x.mountReference || {}), kind: 'surface', surface: pl.surface, elementGuid: pl.element?.guid || null, elementId: pl.element?.id ?? null, elementName: pl.element?.name || '', normal: pl.normal.map(r2), status: 'ok', message: '拖动放置' };
        if (room) { x.roomId = room.id; x.roomExpressId = room.expressId; }
        this.updateDerived(x);
      }, 'drag:' + d.id);
      const lp = this.frames.worldToLocal(f.position.ifcWorld), o = this.plan.origin;
      $('#ltHint').textContent = `拖动 ${f.name} · X ${Math.round((lp[0] - o[0]) * 1000)} · Y ${Math.round((lp[1] - o[1]) * 1000)} mm · 安装高度 ${r2(lp[2] - (room?.floor ?? 0))} m`;
    });
  }
  /** mouse ray ∩ horizontal plane at IFC local height z -> [x, y] or null */
  rayToHeight(e, z) {
    const r = this.v.canvas.getBoundingClientRect(), ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1), this.v.camera);
    const hit = ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -z), new THREE.Vector3());   // view Y = IFC z
    return hit ? this.frames.viewToLocal(hit.toArray()).slice(0, 2) : null;
  }
  /** move a luminous surface (its emitting faces and, once moved, a copy of the element replacing the original) */
  moveLuminous(id, [x, y], merge = null, z = null) {
    const f = this.state.fixture(id); if (!f) return;
    const l = this.frames.worldToLocal(f.position.ifcWorld), p = [x, y, z ?? l[2]];
    const storey = this.rooms.filter(r => Math.abs(r.floor - (this.roomById(f.roomId)?.floor ?? this.room.floor)) < 0.5);
    const room = roomAt(storey, p[0], p[1]);
    this.state.commit('move luminous', d => {
      const q = d.schemes[d.activeScheme].fixtures.find(o => o.fixtureId === id);
      q.position.ifcWorld = this.frames.localToWorld(p);
      if (room && room.id !== q.roomId) { q.roomId = room.id; q.roomExpressId = room.expressId; }
      this.updateDerived(q);
    }, merge);
  }
  /** turn a luminous surface about its centre; q = unit quaternion in IFC local ([x, y, z, w]) or null = original orientation */
  rotateLuminous(id, q, merge = null) {
    this.state.commit('rotate luminous', d => {
      const x = d.schemes[d.activeScheme].fixtures.find(o => o.fixtureId === id); if (!x?.luminous) return;
      if (!q || !LUM.isRotated(q)) delete x.luminous.rotation; else x.luminous.rotation = q.map(v => +v.toFixed(6));
    }, merge);
  }
  /** re-apply the element filter when the set of moved luminous elements changes */
  syncMovedLuminous() {
    const key = [...this.movedLuminous()].sort().join(',');
    if (key === this._movedKey) return; this._movedKey = key;
    if (this.view === 'global') this.setView('global'); else this.applyRoomFilter();
  }
  dragEnd() {
    const d = this._drag; if (!d) return;
    this._drag = null; this.v.controls.enabled = true; this.v.canvas.style.cursor = '';
    if (d.moved) { this.dragging = false; this.preview.suspendShadows = false; this.v.invalidateShadows(); this.renderInspector(); this.renderFixtureList(); }
  }

  /* ---------- luminous surfaces: BIM elements assigned as emitters ---------- */
  /** IFC local triangles (flat) of one element, all of its own (non-duplicate) surfaces incl. translucent ones */
  elementTriangles(k) {
    this._triCache ||= new Map(); if (this._triCache.has(k)) return this._triCache.get(k);
    const g = this.v.geometry, P = g.position, el = g.element, cv = g.cover, out = [];
    for (let v = 0; v < g.vertices; v += 3) {
      if (el[v] !== k || cv[v]) continue;
      for (let j = 0; j < 3; j++) { const i = (v + j) * 3; out.push(P[i], -P[i + 2], P[i + 1]); }   // view -> IFC local
    }
    const flat = Float64Array.from(out); this._triCache.set(k, flat); return flat;
  }
  /** (Re)build the emitting patches of every luminous fixture in every scheme (cached by element / faces / room). */
  prepareLuminous() {
    const d = this.state.design; if (!d || !this.v.geometry) return;
    this._lumKey ||= new Map();
    const els = this.v.elements, live = new Set();
    for (const s of Object.values(d.schemes)) for (const f of s.fixtures) {
      if (f.fixtureType !== 'luminous' || !f.luminous) continue;
      live.add(f.fixtureId);
      if (!f.luminous.anchor) f.luminous.anchor = [...f.position.ifcWorld];                 // where the element itself is
      const rot = LUM.isRotated(f.luminous.rotation) ? f.luminous.rotation : null;
      const key = [f.luminous.elementGuid, f.luminous.faces, f.roomId, f.luminous.anchor.join(','), rot?.join(',') || ''].join('|');
      if (this._lumKey.get(f.fixtureId) === key && P.LUMINOUS.has(f.fixtureId)) continue;
      const k = els.findIndex(e => e.guid === f.luminous.elementGuid);
      if (k < 0) { P.LUMINOUS.delete(f.fixtureId); continue; }
      const room = this.roomById(f.roomId);
      const toward = room ? [(room.min[0] + room.max[0]) / 2, (room.min[1] + room.max[1]) / 2, room.floor + 1.2] : null;
      const origin = this.frames.worldToLocal(f.luminous.anchor);
      const all0 = LUM.triangles(this.elementTriangles(k)), sel = new Set(LUM.selectFaces(all0, f.luminous.faces || 'auto', toward));
      const all = rot ? LUM.rotateTriangles(all0, rot, origin) : all0;            // faces chosen in the element's own orientation, then turned with it
      const faces = all.filter((t, i) => sel.has(all0[i]));
      const pp = LUM.patches(faces, { size: 0.1, maxPatches: 400 });
      P.LUMINOUS.set(f.fixtureId, { ...pp, faces, all, origin, element: k, rotated: !!rot });
      this._lumKey.set(f.fixtureId, key);
    }
    for (const id of [...P.LUMINOUS.keys()]) if (!live.has(id)) P.LUMINOUS.delete(id);
  }
  assignLuminous(k) {
    const e = this.v.elements[k]; if (!e?.bbox) return;
    if (e.category === 7) { this.v.toast('IfcSpace 房间空间不能作为发光体'); return; }
    const tris = LUM.triangles(this.elementTriangles(k)); if (!tris.length) { this.v.toast('该构件没有可用的几何面'); return; }
    let A = 0; const c = [0, 0, 0];
    for (const t of tris) { A += t.area; for (let q = 0; q < 3; q++) c[q] += (t.a[q] + t.b[q] + t.c[q]) / 3 * t.area; }
    const cen = c.map(v => v / A);
    const storey = this.rooms.filter(r => Math.abs(r.floor - (this.room?.floor ?? r.floor)) < 0.5);
    const room = roomAt(storey, cen[0], cen[1]) || this.room;
    const f = createFixture('luminous', { roomId: room?.id || null, roomExpressId: room?.expressId || null, ifcProjectId: this.v.model.project?.guid || null, position: this.frames.localToWorld(cen) });
    f.name = `LUM-${String(this.state.fixtures.filter(x => x.fixtureType === 'luminous').length + 1).padStart(2, '0')}`;
    f.luminous = { elementGuid: e.guid, elementId: e.id, elementName: e.name, faces: 'auto', anchor: [...f.position.ifcWorld] };
    f.mountReference = { kind: 'element', elementGuid: e.guid, elementId: e.id, elementName: e.name, status: 'ok', message: '赋值发光体' };
    f.electrical = { supply: 'lv24' };
    // flux from the default luminance over the faces that face the room
    const toward = room ? [(room.min[0] + room.max[0]) / 2, (room.min[1] + room.max[1]) / 2, room.floor + 1.2] : null;
    const area = LUM.selectFaces(tris, 'auto', toward).reduce((s, t) => s + t.area, 0) || A;
    const L = FIXTURE_TYPES.luminous.defaults.luminance;
    f.photometricParameters.luminance = L; f.photometricParameters.flux = Math.round(LUM.fluxFromLuminance(L, area));
    f.photometricParameters.power = Math.round(f.photometricParameters.flux / 60 * 10) / 10;   // ~60 lm/W (LED membrane / panel)
    this.updateDerived(f);
    this.state.commit('assign luminous', d => d.schemes[d.activeScheme].fixtures.push(f));
    this.openFixture(f.fixtureId);
    this.v.toast(`已将「${e.name}」赋值为发光体 ${f.name}（${area.toFixed(2)} m² · ${L} cd/m²）`);
  }
  openFixture(id) {
    this.pickFilter = 'fixture'; document.querySelectorAll('[data-lt-pick]').forEach(x => x.classList.toggle('active', x.dataset.ltPick === 'fixture'));
    this.state.select(id);
  }
  /** keep the luminance when the emitting faces change: flux follows the area */
  setLuminous(patch) {
    const f = this.state.selected; if (!f) return; const id = f.fixtureId;
    this.state.commit('luminous', d => {
      const x = d.schemes[d.activeScheme].fixtures.find(q => q.fixtureId === id);
      Object.assign(x.luminous, patch.luminous || {}); Object.assign(x.photometricParameters, patch.photometry || {});
    });
    const g = P.LUMINOUS.get(id), x = this.state.selected;
    if (g && x && patch.luminous) {                       // faces changed: rebuilt in onDesignChange -> rescale flux to the same luminance
      const L = x.photometricParameters.luminance ?? LUM.luminanceFromFlux(x.photometricParameters.flux, g.area);
      this.state.commit('luminous flux', d => { const y = d.schemes[d.activeScheme].fixtures.find(q => q.fixtureId === id); y.photometricParameters.flux = Math.round(LUM.fluxFromLuminance(L, P.LUMINOUS.get(id).area)); }, 'lum:' + id);
    }
  }
  renderLuminousInspector(box, f) {
    const ph = f.photometricParameters, g = P.LUMINOUS.get(f.fixtureId), A = g?.area || 0, fmt = this.v.fmt, safe = this.v.safe, room = this.roomById(f.roomId);
    const L = ph.luminance ?? LUM.luminanceFromFlux(ph.flux, A);
    box.innerHTML = `
      <div class="lt-head"><input class="lt-name" id="ltName" value="${safe(f.name)}"><span class="disc-tag">LUM</span></div>
      <div class="lt-badges"><span class="lt-generic">发光体 · 均匀漫射（朗伯）</span><span>${safe(room?.name || '未关联房间')}</span></div>
      ${!g ? '<div class="lt-warn">构件在当前模型中不存在或没有几何，无法发光</div>' : ''}
      <div class="data-row"><span>发光构件</span><strong>${safe(f.luminous?.elementName || '')}</strong></div>
      <label class="lt-field"><span>发光面</span><select id="ltLumFaces" class="lt-select lt-inline">${Object.entries(LUM.FACE_MODES).map(([k, l]) => `<option value="${k}" ${k === (f.luminous?.faces || 'auto') ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <div class="data-row"><span>发光面积</span><strong>${fmt(A, 2)} m² · ${g?.faces.length || 0} 个面 · ${g?.patches.length || 0} 个计算单元</strong></div>
      <div class="lt-sub">光学参数</div>
      <label class="lt-field lt-check"><span>开关</span><button id="ltOn" class="${ph.on ? 'active' : ''}">${ph.on ? '开启' : '关闭'}</button></label>
      <label class="lt-field"><span>表面亮度</span><input type="range" min="10" max="5000" step="10" value="${Math.round(L)}" id="ltLumL"><input type="number" min="1" max="20000" step="10" value="${Math.round(L)}" id="ltLumLn"><em>cd/m²</em></label>
      <div class="lt-derived">总光通量 Φ = π·L·A = <b>${fmt(ph.flux, 0)} lm</b>（单面发光、均匀漫射）</div>
      <label class="lt-field"><span>色温</span><input type="range" min="1800" max="6500" step="100" value="${ph.cct}" data-path="photometricParameters.cct"><input type="number" min="1800" max="6500" step="100" value="${ph.cct}" data-path="photometricParameters.cct"><em>K</em></label>
      <label class="lt-field"><span>调光</span><input type="range" min="0" max="100" step="1" value="${ph.dimming}" data-path="photometricParameters.dimming"><input type="number" min="0" max="100" step="1" value="${ph.dimming}" data-path="photometricParameters.dimming"><em>%</em></label>
      <label class="lt-field"><span>功率</span><input type="range" min="0" max="500" step="0.5" value="${ph.power}" data-path="photometricParameters.power"><input type="number" min="0" max="500" step="0.5" value="${ph.power}" data-path="photometricParameters.power"><em>W</em></label>
      <div class="lt-derived">光效 ${ph.power > 0 ? fmt(ph.flux / ph.power, 0) + ' lm/W' : '—'} · 亮度参考：发光膜天花 200–800、灯箱 / 透光石材 500–2000 cd/m²</div>
      <div class="lt-sub">弱电 / 供电</div>
      <label class="lt-field"><span>供电</span><select id="ltSupply" class="lt-select lt-inline">${[['lv24', '24V 恒压（外置驱动）'], ['lv12', '12V 恒压（外置驱动）'], ['mains', '220V']].map(([v, l]) => `<option value="${v}" ${(f.electrical?.supply || 'lv24') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="lt-field lt-num"><span>控制分组</span><input type="text" id="ltGroup" placeholder="默认：发光体" value="${safe(f.electrical?.group || '')}"></label>
      <div class="lt-sub">位置</div>
      ${(() => { const l = this.frames.worldToLocal(f.position.ifcWorld), o = g?.origin || l, dv = [0, 1, 2].map(i => Math.round((l[i] - o[i]) * 1000));
        return `<div class="data-row"><span>相对原构件</span><strong>ΔX ${dv[0]} · ΔY ${dv[1]} · ΔZ ${dv[2]} mm${dv.some(v => v) ? '（原构件在照明模式中隐藏）' : '（原位）'}</strong></div>
        <label class="lt-field lt-num"><span>高度偏移</span><input type="number" step="10" id="ltLumDz" value="${dv[2]}"><em>mm</em></label>`; })()}
      ${(() => { const e = lumEulerDeg(f.luminous?.rotation);
        return `<div class="lt-sub">旋转（绕自身中心）</div>
        <label class="lt-field lt-num"><span>平面转角 Z</span><input type="number" step="5" id="ltLumRz" value="${e[2]}"><em>°</em></label>
        <label class="lt-field lt-num"><span>倾斜 X</span><input type="number" step="5" id="ltLumRx" value="${e[0]}"><em>°</em></label>
        <label class="lt-field lt-num"><span>倾斜 Y</span><input type="number" step="5" id="ltLumRy" value="${e[1]}"><em>°</em></label>`; })()}
      <div class="lt-btns"><button id="ltLumReset">复位到原位置</button><button id="ltLumRot0">清除旋转</button><button id="ltDel">取消发光体</button></div>
      <div class="lt-derived">「移动」/「选择」工具下用操作轴平移（红 X · 蓝 Y · 绿 高度），「旋转」工具下用旋转环（绿环 = 平面内转动，红 / 蓝环 = 倾斜），也可直接按住拖动或在「平面定位」中拖动 / 输入坐标。ID ${f.fixtureId}</div>`;
    box.querySelectorAll('input[data-path]').forEach(inp => inp.addEventListener('input', () => {
      const v = +inp.value; if (!Number.isFinite(v)) return;
      box.querySelectorAll(`input[data-path="${inp.dataset.path}"]`).forEach(o => { if (o !== inp) o.value = v; });
      this._editing = true; this.setField(inp.dataset.path, v); this._editing = false;
    }));
    const setL = v => { if (!(v > 0)) return; this._editing = true; this.state.commit('luminance', d => { const x = d.schemes[d.activeScheme].fixtures.find(q => q.fixtureId === f.fixtureId); x.photometricParameters.luminance = v; x.photometricParameters.flux = Math.round(LUM.fluxFromLuminance(v, A)); }, 'lumL:' + f.fixtureId); this._editing = false;
      $('#ltLumL').value = v; $('#ltLumLn').value = v; box.querySelector('.lt-derived b').textContent = Math.round(LUM.fluxFromLuminance(v, A)) + ' lm'; };
    $('#ltLumL').oninput = e => setL(+e.target.value); $('#ltLumLn').onchange = e => setL(+e.target.value);
    $('#ltLumFaces').onchange = e => this.setLuminous({ luminous: { faces: e.target.value } });
    $('#ltOn').onclick = () => this.setField('photometricParameters.on', !ph.on, false);
    $('#ltName').onchange = e => this.setField('name', e.target.value.trim() || f.name, false);
    $('#ltSupply').onchange = e => this.setField('electrical', { ...(f.electrical || {}), supply: e.target.value }, false);
    $('#ltGroup').onchange = e => this.setField('electrical', { ...(f.electrical || {}), group: e.target.value.trim() || null }, false);
    $('#ltDel').onclick = () => this.remove();
    $('#ltLumReset').onclick = () => { if (g) { this.moveLuminous(f.fixtureId, g.origin.slice(0, 2), null, g.origin[2]); this.rotateLuminous(f.fixtureId, null); } };
    $('#ltLumRot0').onclick = () => this.rotateLuminous(f.fixtureId, null);
    for (const id of ['ltLumRx', 'ltLumRy', 'ltLumRz']) $('#' + id).onchange = () => {
      const deg = ['ltLumRx', 'ltLumRy', 'ltLumRz'].map(k => +$('#' + k).value || 0);
      this.rotateLuminous(f.fixtureId, lumQuatFromEulerDeg(deg));
    };
    $('#ltLumDz').onchange = e => { const v = +e.target.value; if (!g || !Number.isFinite(v)) return; const l = this.frames.worldToLocal(f.position.ifcWorld); this.moveLuminous(f.fixtureId, [l[0], l[1]], null, g.origin[2] + v / 1000); };
  }

  /* ---------- gizmo (TransformControls) ---------- */
  attachGizmo() {
    const f = this.state.selected;
    const lum = f?.fixtureType === 'luminous';         // luminous surface: translate gizmo with select / move (no rotation)
    if (!this.tc || !this.active || !f || !(this.tool === 'move' || this.tool === 'rotate' || (lum && this.tool === 'select'))) { this.tc?.detach(); this.v.requestRender(); return; }
    const local = this.frames.worldToLocal(f.position.ifcWorld);
    if (lum) {
      const ds = this.state.design.designerSettings;
      this.proxy.position.set(...this.frames.localToView(local)); this.proxy.quaternion.copy(lumQuatToView(f.luminous?.rotation));
      this.tc.attach(this.proxy); this.tc.setSpace('world');
      Object.assign(this.tc, { showX: true, showY: true, showZ: true });                 // view Y = height (green ring = turn in plan)
      if (this.tool === 'rotate') { this.tc.setMode('rotate'); this.tc.setRotationSnap(ds.snap ? THREE.MathUtils.degToRad(5) : null); }
      else { this.tc.setMode('translate'); this.tc.setTranslationSnap(ds.snap ? ds.snapStep : null); }
      this.v.requestRender(); return;
    }
    this.proxy.position.set(...this.frames.localToView(local));
    this.proxy.quaternion.copy(orientation(this.frames, f.rotation, f.fixtureType));
    this.tc.attach(this.proxy);
    const ds = this.state.design.designerSettings, wall = f.mountReference?.surface === 'wall';
    if (this.tool === 'move') {
      this.tc.setMode('translate'); this.tc.setSpace('world');
      Object.assign(this.tc, { showX: true, showY: wall, showZ: true });
      this.tc.setTranslationSnap(ds.snap ? ds.snapStep : null);
    } else {
      this.tc.setMode('rotate'); this.tc.setSpace('local');
      const free = f.fixtureType === 'spotlight';
      Object.assign(this.tc, { showX: free, showY: true, showZ: free });
      this.tc.setRotationSnap(ds.snap ? THREE.MathUtils.degToRad(5) : null);
    }
    this.v.requestRender();
  }
  onTransform() {
    const f = this.state.selected; if (!f) return;
    const id = f.fixtureId;
    if (f.fixtureType === 'luminous') {
      if (this.tc.mode === 'rotate') { this.rotateLuminous(id, lumQuatFromView(this.proxy.quaternion), 'rotate:' + id); return; }
      const l = this.frames.viewToLocal(this.proxy.position.toArray());
      this.moveLuminous(id, [l[0], l[1]], 'move:' + id, l[2]); return;
    }
    if (this.tool === 'move') {
      const local = this.frames.viewToLocal(this.proxy.position.toArray());
      this.state.commit('move', d => { const x = d.schemes[d.activeScheme].fixtures.find(q => q.fixtureId === id); x.position.ifcWorld = this.frames.localToWorld(local); this.updateDerived(x); }, 'move:' + id);
    } else {
      const rot = rotationFromQuaternion(this.frames, this.proxy.quaternion);
      this.state.commit('rotate', d => {
        const x = d.schemes[d.activeScheme].fixtures.find(q => q.fixtureId === id);
        x.rotation.bodyRotation = r2(rot.bodyRotation);
        if (x.fixtureType === 'spotlight') { x.rotation.aimTilt = r2(Math.min(90, rot.aimTilt)); x.rotation.aimAzimuth = r2(rot.aimAzimuth); }
      }, 'rotate:' + id);
    }
  }
  afterTransform() {
    const f = this.state.selected; if (!f) return;
    const res = this.checkMount(f), local = this.frames.worldToLocal(f.position.ifcWorld);
    this.state.commit('verify', d => {
      const x = d.schemes[d.activeScheme].fixtures.find(q => q.fixtureId === f.fixtureId);
      Object.assign(x.mountReference, { status: res.ok ? 'ok' : 'invalid', message: res.message });
    }, 'move:' + f.fixtureId);
    if (!res.ok) this.v.toast(res.message);
    if (this.room && f.roomId === this.room.id && !this.room.contains(local[0], local[1])) this.v.toast('灯具已移出房间范围，不再计入本房间照度统计以外的区域');
  }

  /* ---------- edit commands ---------- */
  duplicate() {
    const f = this.state.selected; if (!f) return;
    const copy = JSON.parse(JSON.stringify(f)); copy.fixtureId = newFixtureId(); copy.name = f.name + ' 副本';
    const local = this.frames.worldToLocal(f.position.ifcWorld), room = this.roomById(f.roomId);
    const step = Math.max(0.3, this.state.design.designerSettings.snapStep * 12);
    const off = [[step, 0], [-step, 0], [0, step], [0, -step]].find(([dx, dy]) => !room || room.contains(local[0] + dx, local[1] + dy)) || [step, 0];
    copy.position.ifcWorld = this.frames.localToWorld([local[0] + off[0], local[1] + off[1], local[2]]);
    copy.mountReference.status = 'unverified'; const res = this.checkMount(copy); Object.assign(copy.mountReference, { status: res.ok ? 'ok' : 'invalid', message: res.message });
    this.updateDerived(copy);
    this.state.commit('duplicate', d => d.schemes[d.activeScheme].fixtures.push(copy)); this.state.select(copy.fixtureId);
  }
  remove() {
    const f = this.state.selected; if (!f) return;
    this.state.commit('delete', d => { const list = d.schemes[d.activeScheme].fixtures; list.splice(list.findIndex(q => q.fixtureId === f.fixtureId), 1); });
    this.state.select(null);
  }
  array(nx, ny, dx, dy) {
    const f = this.state.selected; if (!f) return;
    nx = Math.max(1, Math.min(20, nx | 0)); ny = Math.max(1, Math.min(20, ny | 0));
    const room = this.roomById(f.roomId), base = this.frames.worldToLocal(f.position.ifcWorld);
    const copies = []; let skipped = 0, invalid = 0;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      if (!i && !j) continue;
      const p = [base[0] + i * dx, base[1] + j * dy, base[2]];
      if (room && !room.contains(p[0], p[1])) { skipped++; continue; }
      const c = JSON.parse(JSON.stringify(f)); c.fixtureId = newFixtureId(); c.name = `${f.name}-${i + 1}.${j + 1}`;
      c.position.ifcWorld = this.frames.localToWorld(p);
      const res = this.checkMount(c); c.mountReference = { ...c.mountReference, status: res.ok ? 'ok' : 'invalid', message: res.message }; if (!res.ok) invalid++;
      this.updateDerived(c); copies.push(c);
    }
    this.state.commit('array', d => d.schemes[d.activeScheme].fixtures.push(...copies));
    this.v.toast(`阵列新增 ${copies.length} 盏${skipped ? `，${skipped} 个位置在房间外已跳过` : ''}${invalid ? `，${invalid} 盏未找到安装面（需确认）` : ''}`);
  }
  setField(path, value, merge = true) {
    const f = this.state.selected; if (!f) return;
    const id = f.fixtureId;
    this.state.commit('edit ' + path, d => {
      const x = d.schemes[d.activeScheme].fixtures.find(q => q.fixtureId === id);
      const keys = path.split('.'); let o = x; for (const k of keys.slice(0, -1)) o = o[k];
      const old = o[keys.at(-1)];
      o[keys.at(-1)] = value;
      if (path === 'photometricParameters.suspension' && Number.isFinite(old)) {   // pendant: the canopy stays on the ceiling
        const w = [...x.position.ifcWorld]; w[2] += old - value; x.position.ifcWorld = w; this.updateDerived(x);
      }
      if (path.startsWith('position') || path === 'mountHeight') this.updateDerived(x);
    }, merge ? 'field:' + id + path : null);
  }
  setPositionAxis(axis, valueWorld) {
    const f = this.state.selected; if (!f) return;
    const w = [...f.position.ifcWorld]; w[axis] = valueWorld;
    this.setField('position.ifcWorld', w);
    this.afterTransform();
  }
  setMountHeight(h) {
    const f = this.state.selected, room = this.roomById(f?.roomId); if (!f || !room) return;
    const w = [...f.position.ifcWorld]; w[2] = this.frames.localToWorld([0, 0, room.floor + h])[2];
    this.setField('position.ifcWorld', w); this.afterTransform();
  }

  /* ---------- design change -> preview + calculation ---------- */
  onDesignChange() {
    if (!this.ready) return;
    this.prepareLuminous(); if (this.active) this.syncMovedLuminous();     // also after undo / reset / scheme switch
    if (this.plan.open) { this.plan.renderFixtures(); this.plan.renderOverlay(); }
    this.syncPreview(); this.syncDaylight(); this.scheduleCalc();
    if (!this.dragging) this.attachGizmo();
    this.renderFixtureList(); this.renderScheme();
    if (!this._editing) this.renderInspector();     // keep the slider being dragged alive
  }
  syncPreview() {
    if (!this.preview || !this.state.design) return;
    const ds = this.state.design.designerSettings;
    this.preview.setBudget(ds.previewLights || PREVIEW_LIGHT_BUDGET);
    this.preview.sync(this.state.fixtures, { roomId: this.room?.id, shadows: ds.shadows, beams: ds.beams, bodies: ds.bodies, selectedId: this.state.selectedId, focus: this.viewFocus() });
    this.renderPreviewNote();
    this.v.requestRender();
  }
  /** view focus in IFC local coordinates (orbit target / eye) — the light budget favours what is in front */
  viewFocus() { const t = this.v.controls?.target; return t ? this.frames.viewToLocal(t.toArray()) : null; }
  renderPreviewNote() {
    const ds = this.state.design.designerSettings, st = this.preview.stats;
    const budget = st && st.emitters > st.direct ? `实时预览光源 ${st.budget} 个：${st.direct} 个独立光源${st.clusters ? `，其余 ${st.merged} 个按房间合并为 ${st.clusters} 个等效光源` : ''}${st.droppedRooms ? `（${st.droppedRooms} 个房间未显示光照）` : ''}；照度计算包含全部灯具。` : '';
    $('#ltShadowNote').textContent = (ds.shadows ? (this.preview.shadowLimited ? `阴影仅用于本房间最亮的 ${MAX_SHADOW_LIGHTS} 个光源，其余光源会穿透构件。` : `阴影：${this.preview.shadowed} 个光源。`) : '阴影关闭：预览光线会穿透墙体与构件。') + budget;
  }
  applyDisplay() {
    const ds = this.state.design.designerSettings;
    this.v.setDisplayLighting(false, { environment: ds.ambient, exposure: ds.exposure });   // display aid only
  }
  scheduleCalc() {
    if (this.calcPending || !this.active) return; this.calcPending = true;
    requestAnimationFrame(() => { this.calcPending = false; this.calculate(); });
  }
  /** Illuminance Analysis: direct E on the room's work plane, cached per fixture (incremental). */
  calculate() {
    const room = this.room; if (!room) return;
    const t0 = performance.now(), cs = this.state.design.calculationSettings, ds = this.state.design.designerSettings;
    const spacing = cs.gridSpacing === 'auto' ? P.autoSpacing(room.area) : +cs.gridSpacing;
    const border = cs.border ?? 0.5;
    const z = room.floor + cs.workplaneHeight, gkey = [room.id, spacing, z, border, JSON.stringify(room.footprint)].join('|');
    if (!this.gridCache || this.gridCache.key !== gkey) { this.gridCache = { key: gkey, grid: P.workplaneGrid(room.footprint, room.holes, z, spacing, border) }; this.contrib.clear(); }
    const grid = this.gridCache.grid, fixtures = this.fixturesIn(room), total = new Float64Array(grid.points.length);
    let recomputed = 0; const live = new Set();
    for (const f of fixtures) {
      const key = JSON.stringify([f.fixtureType, f.position.ifcWorld, f.rotation, f.photometricParameters, f.luminous]);
      let c = this.contrib.get(f.fixtureId);
      if (!c || c.key !== key) { c = { key, values: P.gridIlluminance(grid.points, P.fixtureEmitters(f, this.frames.worldToLocal(f.position.ifcWorld))) }; this.contrib.set(f.fixtureId, c); recomputed++; }
      live.add(f.fixtureId); for (let k = 0; k < total.length; k++) total[k] += c.values[k];
    }
    for (const id of [...this.contrib.keys()]) if (!live.has(id)) this.contrib.delete(id);
    const stats = P.illuminanceStats(total);
    this.result = { grid, values: total, stats, ms: performance.now() - t0, recomputed, fixtures };
    // Radiance result is displayed only while it matches the current design, grid and settings
    const req = this.simRequest(); this.simKey = req && SIM.requestKey(req);
    const simOk = this.analysis === 'simulation' && this.sim && this.sim.key === this.simKey;
    const shown = simOk ? this.sim.result.total : total, blocked = simOk ? this.sim.result.blocked : null;
    const shownStats = simOk ? SIM.statsExcluding(shown, blocked) : stats;
    // auto scale from the 95th percentile, so one narrow-beam hot spot does not wash the rest of the room into the bottom colour
    const legendMax = ds.legendMax === 'auto' ? niceMax(P.percentile(shown, 95) || shownStats?.Emax || 0) : +ds.legendMax;
    this.result.legendMax = legendMax; this.result.shownStats = shownStats; this.result.source = simOk ? 'simulation' : 'estimate';
    if (this.view === 'global') { this.heatmap.clear(); this.showGlobalHeatmaps(ds); }
    else if (ds.heatmap && this.active) this.heatmap.show(grid, shown, { legendMax, showValues: ds.sampleValues, floor: room.floor, blocked });
    else this.heatmap.clear();
    this.renderStats(); this.renderSim(); this.renderLegend(); this.v.requestRender();
  }

  /** Global view: real-time estimate for every room that has fixtures, one shared legend scale. */
  showGlobalHeatmaps(ds) {
    this.clearGlobalHeatmaps();
    if (!this.active) return;
    const cs = this.state.design.calculationSettings, items = [];
    for (const r of this.rooms) {
      const fx = this.fixturesIn(r); if (!fx.length) continue;
      const spacing = cs.gridSpacing === 'auto' ? P.autoSpacing(r.area) : +cs.gridSpacing;
      const grid = P.workplaneGrid(r.footprint, r.holes, r.floor + cs.workplaneHeight, spacing, cs.border ?? 0.5);
      const em = fx.flatMap(f => P.fixtureEmitters(f, this.frames.worldToLocal(f.position.ifcWorld)));
      items.push({ r, grid, values: P.gridIlluminance(grid.points, em), fx });
    }
    const levels = this.v.model.levels || [];
    this.globalSummary = items.map(({ r, values, fx }) => ({ room: r, level: levels[r.element.level]?.name || '—', elevation: levels[r.element.level]?.elevation ?? r.floor,
      count: fx.length, power: fx.reduce((a, f) => a + (f.photometricParameters.on ? f.photometricParameters.power * f.photometricParameters.dimming / 100 : 0), 0),
      stats: P.illuminanceStats([...values]) }));
    const all = items.flatMap(x => [...x.values]);
    const legendMax = ds.legendMax === 'auto' ? niceMax(P.percentile(all, 95) || 0) : +ds.legendMax;
    this.result.legendMax = legendMax; this.result.globalRooms = items.length;
    if (!ds.heatmap) return;
    this.globalHeatmaps = items.map(({ r, grid, values }) => {
      const h = new IlluminanceHeatmap(this.v, this.frames);
      h.show(grid, values, { legendMax, showValues: false, floor: r.floor }); return h;
    });
  }
  clearGlobalHeatmaps() { (this.globalHeatmaps || []).forEach(h => h.clear()); this.globalHeatmaps = []; this.v.requestRender(); }

  /* ---------- Radiance simulation & daylight ---------- */
  get simSettings() { return this.state.design.simulationSettings; }
  get daySettings() { return this.state.design?.simulationSettings?.daylight || { enabled: false }; }
  simRequest() {
    if (!this.room || !this.gridCache) return null;
    const req = SIM.buildRequest({ room: this.room, grid: this.gridCache.grid, fixtures: this.state.fixtures, frames: this.frames,
      settings: this.simSettings, trueNorth: this.v.model.site?.trueNorth });
    const allowed = this.allowedElements();
    if (allowed) req.elementGuids = allowed.map(i => this.v.elements[i]?.guid).filter(Boolean).sort();   // simulate the interior envelope / kept layers only
    return req;
  }
  async runSimulation() {
    const req = this.simRequest(); if (!req || this.simRunning) return;
    if (!req.electric && !req.daylight.enabled) { this.v.toast('人工照明与日光都已关闭，没有可仿真的光源'); return; }
    const key = SIM.requestKey(req); this.simRunning = new AbortController(); this.simError = null;
    this.simProgress = { phase: 'queued', progress: 0, t: 0 }; this.renderSim();
    try {
      const result = await SIM.runSimulation(req, (phase, progress, t) => { this.simProgress = { phase, progress, t }; this.renderSim(); }, this.simRunning.signal);
      this.sim = { key, result, estimate: this.result?.stats || null }; this.analysis = 'simulation';
      this.v.toast(`Radiance 仿真完成（${result.seconds} s）`);
    } catch (err) { this.v.toast('仿真失败：' + err.message); this.simError = err.message; }
    finally { this.simRunning = null; this.calculate(); }
  }
  setSim(path, value) {
    this.state.commit('simulation settings', d => { const keys = path.split('.'); let o = d.simulationSettings; for (const k of keys.slice(0, -1)) o = o[k]; o[keys.at(-1)] = value; }, 'sim:' + path);
  }
  syncDaylight() {
    if (!this.daylight || !this.state.design) return;
    this.sunInfo = this.daylight.sync(this.daySettings, this.room, this.v.model.site?.trueNorth, this.active, this.state.design.designerSettings.exposure);
    this.renderDaylight();
  }
  renderDaylight() {
    const d = this.daySettings, s = this.sunInfo; if (!$('#ltDayOn') || !this.state.design) return;
    $('#ltDayOn').textContent = d.enabled ? '日光 开' : '日光 关'; $('#ltDayOn').classList.toggle('active', !!d.enabled);
    $('#ltDayBody').style.opacity = d.enabled ? 1 : 0.45;
    const pad = n => String(n).padStart(2, '0');
    $('#ltDayDate').value = `${d.year}-${pad(d.month)}-${pad(d.day)}`;
    $('#ltDayHour').value = d.hour; $('#ltDayHourVal').textContent = `${Math.floor(d.hour)}:${pad(Math.round((d.hour % 1) * 60))}`;
    $('#ltDaySky').value = d.sky; $('#ltDayLat').value = d.latitude; $('#ltDayLon').value = d.longitude; $('#ltDayTz').value = d.timezone; $('#ltDayNorth').value = d.northOffset;
    $('#ltSunInfo').textContent = s ? `太阳 ${s.altitude.toFixed(1)}° / ${s.azimuth.toFixed(0)}°` : '—';
    const site = this.v.model.site;
    $('#ltDayNote').innerHTML = `位置${d.locationSource === 'IfcSite' ? '取自 IfcSite（可能是 Archicad 模板默认值，请确认）' : '为手动输入'}；正北取自 IFC TrueNorth${site?.trueNorth ? ` (${site.trueNorth.join(', ')})` : '（缺失，按 +Y）'}${d.northOffset ? ` 并修正 ${d.northOffset}°` : ''}。预览只显示直射阳光与阴影；天空光与反射光以 Radiance 仿真为准。${s && s.altitude <= 0 ? '<b class="lt-stale">此时刻太阳在地平线以下。</b>' : ''}`;
  }
  renderSim() {
    const panel = $('#ltSimPanel'); if (!panel || !this.state.design) return;
    const s = this.simSettings;
    document.querySelectorAll('[data-lt-analysis]').forEach(b => b.classList.toggle('active', b.dataset.ltAnalysis === (this.analysis || 'estimate')));
    panel.hidden = this.analysis !== 'simulation';
    $('#ltSimQuality').value = s.quality; $('#ltSimElectric').classList.toggle('active', s.electric); $('#ltSimOther').classList.toggle('active', s.otherRooms);
    const running = !!this.simRunning, bar = $('#ltSimProgress');
    $('#ltSimRun').disabled = running; $('#ltSimCancel').hidden = !running; bar.hidden = !running;
    if (running) {
      const p = this.simProgress || {}, order = { queued: 0, scene: 0.1, electric: 0.2, daylight: 0.6 };
      const frac = Math.min(0.99, (order[p.phase] ?? 0) + (p.phase === 'electric' || p.phase === 'daylight' ? 0.4 * (p.progress || 0) : 0));
      bar.firstElementChild.style.width = `${Math.round(frac * 100)}%`;
    }
    const st = $('#ltSimStatus'), fresh = this.sim && this.sim.key === this.simKey;
    st.hidden = !(running || this.sim || this.simError);
    st.innerHTML = running ? `仿真中：${{ queued: '排队', scene: '构建场景', electric: '人工照明', daylight: '日光' }[this.simProgress?.phase] || ''} · ${Math.round(this.simProgress?.t || 0)} s`
      : this.simError ? `<span class="lt-stale">${this.v.safe(this.simError)}</span>`
      : this.sim ? (fresh ? `显示 Radiance 结果（${SIM.QUALITY_LABELS[this.sim.result.quality]}，${this.sim.result.seconds} s）` : '<span class="lt-stale">设计或设置已改变，仿真结果已过期，当前显示实时估算。请重新运行。</span>') : '';
    this.renderMaterials();
  }
  renderMaterials() {
    const box = $('#ltMatBox'), r = this.sim?.result; if (!box) return;
    box.hidden = !(this.analysis === 'simulation' && r);
    if (!r) return;
    const ov = this.simSettings.materialReflectance || {};
    const rows = r.materials.filter(m => m.type === 'opaque').sort((a, b) => b.area - a.area).slice(0, 16);
    $('#ltMatTable').innerHTML = '<div class="lt-mat"><small>材质（按面积）</small><small>面积</small><small>反射率</small>' +
      rows.map(m => `<span title="${this.v.safe(m.name)}">${this.v.safe(m.name)}</span><small>${m.area.toFixed(0)} m²</small><input type="number" step="0.01" min="0.01" max="0.95" data-mat="${this.v.safe(m.name)}" value="${ov[m.name] ?? m.default}" class="${ov[m.name] != null ? 'ov' : ''}" title="默认 ${m.default}（颜色推算）">`).join('') +
      r.materials.filter(m => m.type !== 'opaque').map(m => `<span>${this.v.safe(m.name)}</span><small>${m.area.toFixed(0)} m²</small><small>τ ${m.transmittance}</small>`).join('') + '</div>';
    $('#ltMatTable').querySelectorAll('[data-mat]').forEach(inp => inp.onchange = () => {
      const v = +inp.value, name = inp.dataset.mat;
      if (!(v > 0 && v < 1)) { this.v.toast('反射率应在 0–1 之间'); return; }
      this.state.commit('reflectance', d => { d.simulationSettings.materialReflectance = { ...d.simulationSettings.materialReflectance, [name]: v }; });
    });
  }

  /* ---------- UI ---------- */
  wireStaticUI() {
    $('#ltCatalog').innerHTML = Object.entries(FIXTURE_TYPES).filter(([, t]) => !t.assignOnly).map(([k, t]) => `<button class="lt-cat" data-type="${k}"><span class="lt-cat-icon">${t.icon}</span><span><b>${t.label}</b><small>${t.code} · ${t.defaults.flux} lm · ${t.defaults.beamAngle}° · ${t.defaults.cct} K</small></span></button>`).join('');
    document.querySelectorAll('.lt-cat').forEach(b => b.onclick = () => { this.addType = b.dataset.type; this.setTool('add'); this.renderCatalog(); });
    document.querySelectorAll('[data-lt-tool]').forEach(b => b.onclick = () => {
      const t = b.dataset.ltTool;
      if (t === 'duplicate') return this.duplicate(); if (t === 'delete') return this.remove();
      if (t === 'undo') return this.state.undo(); if (t === 'redo') return this.state.redo();
      this.setTool(t);
    });
    document.querySelectorAll('[data-lt-view]').forEach(b => b.onclick = () => this.setView(b.dataset.ltView));
    document.querySelectorAll('[data-lt-pick]').forEach(b => b.onclick = () => { this.pickFilter = b.dataset.ltPick; document.querySelectorAll('[data-lt-pick]').forEach(x => x.classList.toggle('active', x === b)); this.renderInspector(); });
    $('#ltRoomSelect').onchange = e => this.selectRoom(e.target.value);
    const ds = k => this.state.design.designerSettings[k];
    const setDs = (k, v, after) => { this.state.design.designerSettings[k] = v; this.state.dirty = true; after?.(); this.renderDisplay(); };
    document.querySelectorAll('[data-lt-toggle]').forEach(b => b.onclick = () => {
      const k = b.dataset.ltToggle;
      setDs(k, !ds(k), () => { if (k === 'envelopeOnly') { if (ds(k)) this.ensureEnvelope(); this.afterEnvelope(); }
        if (k === 'isolateRoom') this.applyRoomFilter(); if (k === 'heatmap' || k === 'sampleValues') this.calculate(); else this.syncPreview(); if (k === 'snap') this.attachGizmo(); });
    });
    $('#ltExposure').oninput = e => setDs('exposure', Math.pow(10, +e.target.value), () => { this.applyDisplay(); this.syncDaylight(); });
    $('#ltAmbient').oninput = e => setDs('ambient', +e.target.value, () => this.applyDisplay());
    $('#ltSave').onclick = () => this.save();
    $('#ltExport').onclick = () => { store.exportFile(this.state.design); this.v.toast('已导出照明方案 JSON'); };
    $('#ltImportBtn').onclick = () => $('#ltImport').click();
    $('#ltImport').onchange = async e => { const file = e.target.files[0]; e.target.value = ''; if (!file) return;
      try { const d = await store.readFile(file); this.adopt(d, `已导入 ${file.name}`); this.room = this.roomById(this.room?.id) || this.room; this.onDesignChange(); this.drawRoomOutline(); } catch (err) { this.v.toast('导入失败：' + err.message); } };
    $('#ltNewScheme').onclick = () => { let id; this.state.commit('new scheme', d => { id = addScheme(d, { newId: newFixtureId }); }); this.activateScheme(id); };
    $('#ltCopyScheme').onclick = () => {
      const from = this.state.design.activeScheme; let id;
      this.state.commit('copy scheme', d => { id = addScheme(d, { name: d.schemes[from].name + ' 副本', copyFrom: from, newId: newFixtureId }); });
      this.activateScheme(id); this.v.toast('已复制为新方案');
    };
    $('#ltRenameScheme').onclick = () => {
      const d = this.state.design, s = d.schemes[d.activeScheme], name = prompt('方案名称', s.name);
      if (name && name.trim()) this.state.commit('rename scheme', dd => { dd.schemes[dd.activeScheme].name = name.trim(); });
    };
    $('#ltDeleteScheme').onclick = () => {
      const d = this.state.design, ids = Object.keys(d.schemes);
      if (ids.length < 2) { this.v.toast('至少保留一个方案'); return; }
      if (!confirm(`删除「${d.schemes[d.activeScheme].name}」？（可撤销）`)) return;
      const gone = d.activeScheme, next = ids.find(i => i !== gone);
      this.state.commit('delete scheme', dd => { delete dd.schemes[gone]; dd.activeScheme = next; });
      this.activateScheme(next);
    };
    for (const id of ['ltWorkplane', 'ltSpacing', 'ltBorder']) $('#' + id).onchange = () => {
      const wp = +$('#ltWorkplane').value, sp = $('#ltSpacing').value, bd = +$('#ltBorder').value;
      if (!(wp >= 0 && wp <= 2.5)) { this.v.toast('工作面高度应在 0–2.5 m'); return; }
      if (!(bd >= 0 && bd <= 1)) { this.v.toast('墙边排除带应在 0–1 m'); return; }
      this.state.commit('calc settings', d => { d.calculationSettings.workplaneHeight = wp; d.calculationSettings.gridSpacing = sp === 'auto' ? 'auto' : +sp; d.calculationSettings.border = bd; });
      this.gridCache = null;
    };
    $('#ltLegendMax').onchange = e => { const v = e.target.value.trim(); setDs('legendMax', v === '' || v === 'auto' ? 'auto' : Math.max(1, +v) || 'auto', () => this.calculate()); };
    $('#ltSimQuality').innerHTML = Object.entries(SIM.QUALITY_LABELS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
    $('#ltDaySky').innerHTML = Object.entries(SIM.SKY_LABELS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
    document.querySelectorAll('[data-lt-analysis]').forEach(b => b.onclick = () => { this.analysis = b.dataset.ltAnalysis; this.calculate(); });
    $('#ltSimRun').onclick = () => this.runSimulation();
    $('#ltSimCancel').onclick = () => this.simRunning?.abort();
    $('#ltSimQuality').onchange = e => this.setSim('quality', e.target.value);
    $('#ltSimElectric').onclick = () => this.setSim('electric', !this.simSettings.electric);
    $('#ltSimOther').onclick = () => this.setSim('otherRooms', !this.simSettings.otherRooms);
    $('#ltDayOn').onclick = () => this.setSim('daylight.enabled', !this.daySettings.enabled);
    $('#ltDayDate').onchange = e => { const [y, m, d] = e.target.value.split('-').map(Number); if (!m) return; this.setSim('daylight.year', y); this.setSim('daylight.month', m); this.setSim('daylight.day', d); };
    $('#ltDayHour').oninput = e => this.setSim('daylight.hour', +e.target.value);
    $('#ltDaySky').onchange = e => this.setSim('daylight.sky', e.target.value);
    const num = (id, key, lo, hi) => $(id).onchange = e => { const v = +e.target.value; if (!(v >= lo && v <= hi)) { this.v.toast('数值超出范围'); this.renderDaylight(); return; } this.setSim('daylight.' + key, v); if (key === 'latitude' || key === 'longitude') this.setSim('daylight.locationSource', 'manual'); };
    num('#ltDayLat', 'latitude', -90, 90); num('#ltDayLon', 'longitude', -180, 180); num('#ltDayTz', 'timezone', -12, 14); num('#ltDayNorth', 'northOffset', -180, 180);
    this.v.canvas.addEventListener('pointermove', e => this.onPointerMove(e));
    // direct drag of a fixture in 3D (select / move tool): press on a fixture and drag it over ceilings / walls
    this.v.canvas.addEventListener('pointerdown', e => this.dragStart(e), { capture: true });
    window.addEventListener('pointermove', e => this.dragMove(e));
    window.addEventListener('pointerup', e => this.dragEnd(e));
    // camera settled: give the preview lights to what is now in front (cheap, no geometry rebuild)
    this.v.controls.addEventListener('end', () => { if (!this.active || !this.preview) return; clearTimeout(this._relightT);
      this._relightT = setTimeout(() => { this.preview.relight(this.viewFocus()); this.renderPreviewNote(); }, 120); });
    $('#ltPreviewLights').onchange = e => { this.state.design.designerSettings.previewLights = +e.target.value; this.state.dirty = true; this.syncPreview(); };
    this.v.canvas.addEventListener('pointerleave', () => { if (this.ghost) { this.ghost.visible = false; this.v.requestRender(); } });
    window.addEventListener('keydown', e => {
      if (!this.active || e.target.closest('input,textarea,select')) return;
      const k = e.key.toLowerCase(), mod = e.metaKey || e.ctrlKey;
      if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? this.state.redo() : this.state.undo(); }
      else if (mod && k === 'y') { e.preventDefault(); this.state.redo(); }
      else if (mod && k === 'd') { e.preventDefault(); this.duplicate(); }
      else if (k === 'delete' || k === 'backspace') { if (this.state.selected) { e.preventDefault(); this.remove(); } }
      else if (k === 'escape') { if (this.tool !== 'select') this.setTool('select'); else this.state.select(null); this._areaStart = null; }
    });
    window.addEventListener('beforeunload', e => { if (this.state.dirty) { e.preventDefault(); e.returnValue = ''; } });
  }
  /** Show a scheme in the viewer (all views, calculation, plan, ELV use the active scheme). */
  activateScheme(id) {
    const d = this.state.design; if (!d.schemes[id]) return;
    d.activeScheme = id; this.state.selectedId = null; this.contrib.clear(); this.state.dirty = true;
    this.onDesignChange(); this.renderScheme(); this.renderFixtureList(); this.renderInspector();
    this.v.events.dispatchEvent(new CustomEvent('schemechange', { detail: { id } }));
  }
  async save() {
    try { this.state.design.sourceModel = { ...this.sourceModel }; await store.saveToServer(this.v.model.name, this.state.design); this.state.dirty = false; this.renderScheme(); this.v.toast('照明方案已保存（designs/，未写入 IFC）'); }
    catch (err) { this.v.toast(err.message); }
  }
  renderAll() { this.renderDaylight(); this.renderSim(); this.renderCatalog(); this.renderRoomSelect(); this.renderRoomInfo(); this.renderFixtureList(); this.renderInspector(); this.renderDisplay(); this.renderScheme(); this.renderReport(); this.renderLegend(); this.renderStats(); }
  renderCatalog() { document.querySelectorAll('.lt-cat').forEach(b => b.classList.toggle('active', this.tool === 'add' && b.dataset.type === this.addType)); }
  renderRoomSelect() {
    const sel = $('#ltRoomSelect'); if (!sel) return;
    sel.innerHTML = [...this.rooms].sort((a, b) => a.name.localeCompare(b.name, 'zh')).map(r => {
      const n = this.fixturesIn(r).length;
      return `<option value="${r.id}" ${r === this.room ? 'selected' : ''}>${this.v.safe(r.name)} · ${r.area.toFixed(1)} m²${n ? ` · ${n} 灯` : ''}${r.needsConfirmation ? ' · 需确认' : ''}</option>`;
    }).join('');
  }
  renderRoomInfo() {
    const r = this.room, box = $('#ltRoomInfo'); if (!r || !box) return;
    const ov = r.override || {}, fmt = this.v.fmt;
    const ceilings = r.ceilings.slice(0, 3).map(c => `${fmt(c.height, 2)} m <small>${Math.round(c.coverage * 100)}% · ${this.v.safe(c.elements[0]?.name || '')}</small>`).join('<br>') || '—';
    box.innerHTML = `
      <div class="data-row"><span>面积</span><strong>${fmt(r.area, 2)} m²</strong></div>
      <div class="data-row"><span>尺寸</span><strong>${fmt(r.max[0] - r.min[0], 2)} × ${fmt(r.max[1] - r.min[1], 2)} m</strong></div>
      <div class="data-row"><span>地面标高</span><strong>${fmt(r.floor, 3)} m${ov.floor != null ? '（手动）' : ''}</strong></div>
      <div class="data-row"><span>天花（实测）</span><strong>${ceilings}</strong></div>
      <div class="data-row"><span>安装面高度</span><strong>${r.ceiling != null ? fmt(r.ceiling - r.floor, 2) + ' m' : '未知'}${ov.ceiling != null ? '（手动）' : ''}</strong></div>
      <div class="data-row"><span>来源</span><strong>${ov.footprint ? '手动矩形区域' : 'IfcSpace 几何'}</strong></div>
      ${r.needsConfirmation ? `<div class="lt-warn">需人工确认：${r.issues.map(this.v.safe).join('；')}</div>` : (r.issues.length ? `<div class="lt-note">${r.issues.map(this.v.safe).join('；')}（已确认）</div>` : '<div class="lt-ok">IfcSpace 边界与天花探测一致</div>')}
      <details class="lt-manual"><summary>手动指定工作区域 / 高度</summary>
        <label>地面标高 <input type="number" step="0.01" id="ltOvFloor" value="${r.floor}"> m</label>
        <label>安装面高 <input type="number" step="0.01" id="ltOvCeil" value="${r.ceiling != null ? r2(r.ceiling - r.floor) : ''}"> m（距地）</label>
        <div class="lt-btns"><button id="ltOvApply">应用</button><button id="ltOvArea">点选矩形区域</button><button id="ltOvConfirm">确认数据</button><button id="ltOvReset">恢复自动</button></div>
      </details>`;
    $('#ltOvApply').onclick = () => { const f = +$('#ltOvFloor').value, c = +$('#ltOvCeil').value; if (!Number.isFinite(f) || !(c > 1.8 && c < 8)) { this.v.toast('请输入有效的地面标高与 1.8–8 m 的安装面高度'); return; } this.setRoomOverride({ floor: f, ceiling: f + c, confirmed: true }); };
    $('#ltOvArea').onclick = () => { this._areaStart = null; this.setTool('area'); $('#ltHint').textContent = '在地面上点击矩形工作区域的第一个角'; };
    $('#ltOvConfirm').onclick = () => this.setRoomOverride({ confirmed: true });
    $('#ltOvReset').onclick = () => this.clearRoomOverride();
    $('#ltRoomBadge').textContent = r.needsConfirmation ? '需确认' : 'OK';
  }
  renderFixtureList() {
    const box = $('#ltFixtureList'); if (!box || !this.room) return;
    const list = this.fixturesIn(this.room);
    $('#ltFixtureCount').textContent = list.length;
    box.innerHTML = list.length ? list.map(f => {
      const ph = f.photometricParameters, bad = f.mountReference?.status === 'invalid';
      return `<div class="lt-fx ${f.fixtureId === this.state.selectedId ? 'active' : ''} ${ph.on ? '' : 'off'}" data-id="${f.fixtureId}">
        <button class="layer-btn" data-onoff="${f.fixtureId}" title="开 / 关">${ph.on ? '◉' : '○'}</button>
        <span class="lt-fx-name">${FIXTURE_TYPES[f.fixtureType].icon} ${this.v.safe(f.name)}${bad ? ' <em>⚠</em>' : ''}</span>
        <small>${ph.flux} lm · ${ph.beamAngle}°${ph.dimming < 100 ? ` · ${ph.dimming}%` : ''}</small></div>`;
    }).join('') : '<div class="hidden-empty">本房间暂无灯具。在左侧灯具库选择灯型后，在天花上单击放置。</div>';
    box.querySelectorAll('.lt-fx').forEach(row => row.onclick = e => {
      const onoff = e.target.closest('[data-onoff]');
      if (onoff) { const f = this.state.fixture(onoff.dataset.onoff); this.state.select(f.fixtureId); this.setField('photometricParameters.on', !f.photometricParameters.on, false); return; }
      this.state.select(row.dataset.id);
    });
  }
  renderDisplay() {
    if (!this.state.design) return;
    const ds = this.state.design.designerSettings;
    document.querySelectorAll('[data-lt-toggle]').forEach(b => b.classList.toggle('active', !!ds[b.dataset.ltToggle]));
    $('#ltExposure').value = Math.log10(ds.exposure); $('#ltExposureVal').textContent = ds.exposure.toFixed(3);
    $('#ltAmbient').value = ds.ambient; $('#ltAmbientVal').textContent = ds.ambient;
    const cs = this.state.design.calculationSettings;
    $('#ltWorkplane').value = cs.workplaneHeight; $('#ltSpacing').value = String(cs.gridSpacing); $('#ltBorder').value = cs.border ?? 0.5;
    $('#ltLegendMax').value = ds.legendMax === 'auto' ? '' : ds.legendMax;
    this.renderEnvelopeNote(); this.renderLayers();
    $('#ltPreviewLights').value = String(ds.previewLights || PREVIEW_LIGHT_BUDGET);
  }
  renderScheme() {
    if (!this.state.design) return;
    const d = this.state.design;
    const box = $('#ltSchemeList'), safe = this.v.safe;
    box.innerHTML = Object.entries(d.schemes).map(([id, s]) => {
      const r = s.results?.[this.room?.id];
      return `<button class="lt-scheme ${id === d.activeScheme ? 'active' : ''}" data-scheme="${id}" title="${safe(s.brief || '')}">
        <span class="lt-scheme-name">${safe(s.name)}</span>${s.source && s.source !== 'manual' ? `<em class="lt-src lt-src-${s.source}">${SCHEME_SOURCES[s.source]}</em>` : ''}
        <small>${s.fixtures.length} 盏${r ? ` · ${Math.round(r.Eavg)} lx · U0 ${r.U0 == null ? '—' : r.U0.toFixed(2)}` : ''}</small></button>`;
    }).join('');
    box.querySelectorAll('[data-scheme]').forEach(b => b.onclick = () => this.activateScheme(b.dataset.scheme));
    $('#ltSaveState').textContent = this.state.dirty ? '有未保存的修改' : '已保存 / 无修改';
  }
  renderReport() {
    const box = $('#ltReport'); if (!box) return;
    box.innerHTML = this.report.length ? this.report.map(r => `<div class="lt-${r.level === 'error' ? 'warn' : 'note'}">${this.v.safe(r.message)}</div>`).join('') : '';
  }
  renderLegend() {
    const L = $('#ltLegend'); if (!L) return;
    const max = this.result?.legendMax || 100;
    L.querySelector('.lt-grad').style.background = `linear-gradient(90deg, ${LUX_STOPS.map(([t, c]) => `${c} ${t * 100}%`).join(', ')})`;
    L.querySelector('.lt-ticks').innerHTML = [0, 0.25, 0.5, 0.75, 1].map(t => `<span>${t === 1 ? '≥' : ''}${Math.round(max * t)}</span>`).join('');
    const emax = this.result?.stats?.Emax;
    L.querySelector('.lt-legend-note').textContent = this.view === 'global' ? `全局：${this.result?.globalRooms || 0} 个房间的实时估算（仅直接光），共用刻度`
      : emax > max ? `最大 ${Math.round(emax)} lx，超出上限的区域显示为红色` : (this.state.design?.designerSettings.legendMax === 'auto' ? '上限按 95% 采样点自动取整' : '');
    L.hidden = !(this.active && this.state.design?.designerSettings.heatmap);
  }
  renderStats() {
    const box = $('#ltStats'); if (!box || !this.result) return;
    const s = this.result.stats, fx = this.result.fixtures, fmt = this.v.fmt;
    const installed = fx.reduce((a, f) => a + (f.photometricParameters.power || 0), 0);
    const operating = fx.reduce((a, f) => a + (f.photometricParameters.on ? (f.photometricParameters.power || 0) * f.photometricParameters.dimming / 100 : 0), 0);
    const cs = this.state.design.calculationSettings;
    const simOk = this.result.source === 'simulation', sr = simOk ? this.sim.result : null, sh = this.result.shownStats || s;
    const comp = sr ? (() => {
      const row = (label, v) => { const q = SIM.statsExcluding(v, sr.blocked); return `<span>${label}</span><i>${fmt(q.Eavg, 0)}</i><i>${fmt(q.Emin, 0)}</i><i>${fmt(q.Emax, 0)}</i><i>${q.U0 == null ? '—' : fmt(q.U0, 2)}</i>`; };
      const e = sr.components.electric, d = sr.components.daylight, est = this.sim.estimate;
      return `<div class="lt-comp"><span></span><b>Eavg</b><b>Emin</b><b>Emax</b><b>U0</b>${e ? row('人工照明', e) : ''}${d ? row('日光', d) : ''}${row('合计', sr.total)}${est ? `<span>直接光估算</span><i>${fmt(est.Eavg, 0)}</i><i>${fmt(est.Emin, 0)}</i><i>${fmt(est.Emax, 0)}</i><i>${est.U0 == null ? '—' : fmt(est.U0, 2)}</i>` : ''}</div>
        ${sr.sun ? `<div class="data-row"><span>太阳</span><strong>高度 ${fmt(sr.sun.altitude, 1)}° · 方位 ${fmt(sr.sun.azimuth, 1)}°（自南，西为正）</strong></div>` : ''}
        <div class="data-row"><span>仿真范围</span><strong>房间外扩 ${sr.region.margin} m · ${sr.region.elements} 个构件 · ${fmt(sr.region.triangles, 0)} 三角面</strong></div>
        <div class="data-row"><span>参数</span><strong>-ab ${sr.parameters.ab} -ad ${sr.parameters.ad} -aa ${sr.parameters.aa}</strong></div>
        ${sr.warnings.map(w => `<div class="lt-note">${this.v.safe(w)}</div>`).join('')}`;
    })() : '';
    if (this.view === 'global') { this.renderGlobalStats(box); return; }
    box.innerHTML = s ? `
      <div class="lt-sub">${simOk ? 'Radiance 仿真（遮挡 + 多次反射' + (sr.components.daylight ? ' + 日光' : '') + '）' : '实时估算（仅直接光）'}</div>
      <div class="lt-kpis"><div><b>${fmt(sh.Eavg, 0)}</b><small>Eavg lx</small></div><div><b>${fmt(sh.Emin, 0)}</b><small>Emin lx</small></div><div><b>${fmt(sh.Emax, 0)}</b><small>Emax lx</small></div><div><b>${sh.U0 == null ? '—' : fmt(sh.U0, 2)}</b><small>U0</small></div></div>${comp}
      <div class="data-row"><span>灯具数量</span><strong>${fx.length}（开启 ${fx.filter(f => P.effectiveFlux(f.photometricParameters) > 0).length}）</strong></div>
      <div class="data-row"><span>总功率</span><strong>${fmt(operating, 1)} W <small>安装 ${fmt(installed, 1)} W</small></strong></div>
      <div class="data-row"><span>功率密度</span><strong>${fmt(operating / Math.max(this.room.area, 1e-6), 2)} W/m²</strong></div>
      <div class="data-row"><span>采样</span><strong>${s.samples} 点 · ${this.result.grid.spacing} m · 工作面 ${cs.workplaneHeight} m · 墙边排除 ${cs.border ?? 0.5} m</strong></div>
      <div class="data-row"><span>计算</span><strong>${this.result.ms.toFixed(1)} ms · 重算 ${this.result.recomputed} 盏</strong></div>
      <div class="lt-disclaimer">${simOk ? 'Radiance（LBNL）光线追踪仿真：计入仿真范围内构件的遮挡与多次反射、玻璃透射；日光为 CIE 标准天空（gensky）。灯具为通用 cosᵐ 配光（IES 由同一参数生成），材质反射率见下表，未计维护系数。精度取决于反射率与灯具光度数据，不自动代表满足任何照明标准。' : '直接照度逐点估算（E = I·cosα/r²，通用 cosᵐ 光强分布）。<b>未计入</b>遮挡、反射光、日光、维护系数，仅统计本房间灯具。用于拖动时的快速反馈；设计结论请使用 Radiance 仿真。'}</div>`
      : '<div class="hidden-empty">房间内没有有效采样点，请检查房间边界。</div>';
  }
  /** Whole-building summary: totals, then rooms with fixtures grouped by storey (click to open the room). */
  renderGlobalStats(box) {
    const list = this.globalSummary || [], fmt = this.v.fmt, safe = this.v.safe;
    const all = this.state.fixtures, power = list.reduce((a, x) => a + x.power, 0), area = list.reduce((a, x) => a + x.room.area, 0);
    const storeys = [...new Set(list.map(x => x.level))].sort((a, b) => list.find(x => x.level === b).elevation - list.find(x => x.level === a).elevation);
    box.innerHTML = `<div class="lt-sub">全局 · 整栋建筑（${safe(this.state.scheme.name)}）</div>
      <div class="lt-kpis"><div><b>${all.length}</b><small>灯具</small></div><div><b>${list.length}</b><small>布灯房间</small></div><div><b>${fmt(power, 0)}</b><small>W</small></div><div><b>${area ? fmt(power / area, 1) : '—'}</b><small>W/m²</small></div></div>
      ${storeys.map(lv => `<div class="lt-sub">${safe(lv)}</div>` + list.filter(x => x.level === lv).map(x => `<div class="data-row lt-global-row" data-room="${x.room.id}"><span>${safe(x.room.name)} <small>${x.count} 盏</small></span><strong>${fmt(x.stats?.Eavg ?? 0, 0)} lx · U0 ${x.stats?.U0 == null ? '—' : fmt(x.stats.U0, 2)} · ${fmt(x.power / x.room.area, 1)} W/m²</strong></div>`).join('')).join('')
        || '<div class="hidden-empty">当前方案还没有布置任何灯具。</div>'}
      ${(() => { const lit = new Set(list.map(x => x.room.id)), empty = this.rooms.filter(r => !lit.has(r.id) && r.area >= 1 && !isContainerSpace(this.rooms, r)).sort((a, b) => b.area - a.area);
        return empty.length ? `<div class="lt-sub">未布灯房间 ${empty.length} 个</div><div class="lt-empty-rooms">${empty.map(r => `<button data-room="${r.id}">${safe(r.name)}</button>`).join('')}</div>` : ''; })()}
      <div class="lt-disclaimer">显示当前方案「${safe(this.state.scheme.name)}」中所有房间的灯具；各房间为实时直接光估算（未计遮挡、反射与日光），热力图共用一个色标。点击房间进入该房间。</div>`;
    box.querySelectorAll('[data-room]').forEach(row => row.onclick = () => this.selectRoom(row.dataset.room, 'orbit'));
  }
  renderInspector() {
    const box = $('#ltInspector'); if (!box) return;
    if (this.pickFilter === 'bim') {
      const i = this.v.state.primary, e = this.v.elements[i];
      const lum = e && this.state.fixtures.find(f => f.fixtureType === 'luminous' && f.luminous?.elementGuid === e.guid);
      box.innerHTML = `<div class="lt-sub">BIM 构件选择模式</div>${e ? `<div class="data-row"><span>${this.v.safe(e.type)}</span><strong>${this.v.safe(e.name)} #${e.id}</strong></div>
        ${e.layer ? `<div class="data-row"><span>图层</span><strong>${this.v.safe(e.layer)}</strong></div>` : ''}
        <div class="lt-btns">${lum ? `<button id="ltLumOpen" class="lt-primary">打开发光体 ${this.v.safe(lum.name)}</button>` : `<button id="ltLumAssign" class="lt-primary" title="把这个构件的表面设为均匀发光面（发光膜、发光片、透光石材等），作为灯具参与照度计算、仿真与出图">赋值为发光体</button>`}</div>
        <div class="lt-note">按 H 隐藏该构件以便观察，Shift+H 全部显示。BIM 属性请回到 BIM Model Explorer 查看。</div>` : '<div class="hidden-empty">点击三维视图中的构件；选中后可「赋值为发光体」。</div>'}`;
      $('#ltLumAssign')?.addEventListener('click', () => this.assignLuminous(i));
      $('#ltLumOpen')?.addEventListener('click', () => this.openFixture(lum.fixtureId));
      return;
    }
    const f = this.state.selected;
    if (!f) { box.innerHTML = '<div class="hidden-empty">选择一盏灯具以编辑参数；或在左侧灯具库选择灯型后在天花上单击放置。</div>'; return; }
    if (f.fixtureType === 'luminous') { this.renderLuminousInspector(box, f); return; }
    const ph = f.photometricParameters, rot = f.rotation, t = FIXTURE_TYPES[f.fixtureType], room = this.roomById(f.roomId), fmt = this.v.fmt;
    const errors = P.validateFixture(f), local = this.frames.worldToLocal(f.position.ifcWorld);
    const m = P.exponentForBeam(ph.beamAngle), I0 = P.peakIntensity(P.effectiveFlux(ph), m);
    const slider = (path, label, unit, min, max, step, val) => `<label class="lt-field"><span>${label}</span><input type="range" min="${min}" max="${max}" step="${step}" value="${val}" data-path="${path}"><input type="number" min="${min}" max="${max}" step="${step}" value="${val}" data-path="${path}"><em>${unit}</em></label>`;
    const num = (label, id, val, unit, step = 0.01) => `<label class="lt-field lt-num"><span>${label}</span><input type="number" step="${step}" id="${id}" value="${val}"><em>${unit}</em></label>`;
    const outside = room && !room.contains(local[0], local[1]);
    box.innerHTML = `
      <div class="lt-head"><input class="lt-name" id="ltName" value="${this.v.safe(f.name)}"><span class="disc-tag">${t.code}</span></div>
      <div class="lt-badges"><span class="lt-generic">通用模拟灯具 · 无厂家光度数据</span><span>${t.label}</span><span>${this.v.safe(room?.name || '未关联房间')}</span></div>
      ${errors.length ? `<div class="lt-warn">${errors.map(this.v.safe).join('；')}</div>` : ''}
      ${f.mountReference?.status === 'invalid' ? `<div class="lt-warn">安装面：${this.v.safe(f.mountReference.message)}</div>` : ''}
      ${outside ? '<div class="lt-warn">灯具位置在所属房间范围外</div>' : ''}
      <div class="lt-sub">光学参数</div>
      <label class="lt-field lt-check"><span>开关</span><button id="ltOn" class="${ph.on ? 'active' : ''}">${ph.on ? '开启' : '关闭'}</button></label>
      ${slider('photometricParameters.flux', '光通量', 'lm', 0, 5000, 10, ph.flux)}
      ${slider('photometricParameters.power', '功率', 'W', 0, 100, 0.5, ph.power)}
      ${slider('photometricParameters.beamAngle', '光束角', '°', P.BEAM_MIN, P.BEAM_MAX, 1, ph.beamAngle)}
      ${slider('photometricParameters.cct', '色温', 'K', 1800, 6500, 100, ph.cct)}
      ${slider('photometricParameters.dimming', '调光', '%', 0, 100, 1, ph.dimming)}
      ${f.fixtureType === 'linear' ? slider('photometricParameters.length', '长度', 'm', 0.1, 6, 0.05, ph.length) : ''}
      ${f.fixtureType === 'pendant' ? slider('photometricParameters.suspension', '吊杆长度', 'm', 0.05, 3, 0.05, ph.suspension) + slider('photometricParameters.upRatio', '上照比例', '', 0, 1, 0.05, ph.upRatio) + slider('photometricParameters.diameter', '灯罩直径', 'm', 0.1, 2, 0.05, ph.diameter) : ''}
      <div class="lt-derived">峰值光强 I0 ≈ ${fmt(I0, 0)} cd · 分布 cos<sup>${fmt(m, 2)}</sup>θ · 光效 ${ph.power > 0 ? fmt(ph.flux / ph.power, 0) + ' lm/W' : '—'}</div>
      <div class="lt-sub">朝向</div>
      ${slider('rotation.aimTilt', '倾斜', '°', 0, 90, 1, r2(rot.aimTilt))}
      ${slider('rotation.aimAzimuth', '方位', '°', -180, 180, 1, r2(rot.aimAzimuth))}
      ${slider('rotation.bodyRotation', '旋转', '°', -180, 180, 1, r2(rot.bodyRotation))}
      <div class="lt-sub">定位（相对${this.state.design.designerSettings.planOrigin ? '定位原点' : 'IFC 项目原点'}，毫米）</div>
      ${num('X', 'ltPx', Math.round((local[0] - this.plan.origin[0]) * 1000), 'mm', 1)}${num('Y', 'ltPy', Math.round((local[1] - this.plan.origin[1]) * 1000), 'mm', 1)}
      ${num('安装高度', 'ltMh', f.mountHeight ?? '', 'm（距地）')}
      <div class="lt-derived">IFC 世界 ${f.position.ifcWorld.map(v => fmt(v, 4)).join(' / ')} m · 房间局部 ${f.position.roomLocal ? f.position.roomLocal.map(v => fmt(v, 3)).join(' / ') : '—'} m${this.view === 'plan' ? '' : ' · 精确定位请用「平面定位」视图'}</div>
      <div class="data-row"><span>安装面</span><strong>${this.v.safe(f.mountReference?.elementName || '手动')} · ${{ ok: '已校验', invalid: '失效', unverified: '未校验' }[f.mountReference?.status] || '—'}</strong></div>
      <div class="lt-sub">弱电 / 供电</div>
      <label class="lt-field"><span>供电</span><select id="ltSupply" class="lt-select lt-inline">${[['', `默认（${f.fixtureType === 'linear' ? '低压恒压' : '220V 一体驱动'}）`], ['mains', '220V 一体驱动'], ['lv24', '24V 恒压（外置驱动）'], ['lv12', '12V 恒压（外置驱动）']].map(([v, l]) => `<option value="${v}" ${(f.electrical?.supply || '') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="lt-field lt-num"><span>控制分组</span><input type="text" id="ltGroup" placeholder="默认按灯型：${{ downlight: '筒灯', spotlight: '射灯', linear: '线性灯', pendant: '吊灯', ceiling: '吸顶灯' }[f.fixtureType]}" value="${this.v.safe(f.electrical?.group || '')}"></label>
      <label class="lt-field lt-num"><span>备注</span><textarea id="ltNotes" rows="2">${this.v.safe(f.notes || '')}</textarea></label>
      <div class="lt-btns"><button id="ltDup">复制</button><button id="ltDel">删除</button></div>
      <details class="lt-manual"><summary>阵列布置</summary>
        <div class="lt-grid4"><label>X 数量<input id="ltAx" type="number" value="2" min="1" max="20"></label><label>Y 数量<input id="ltAy" type="number" value="1" min="1" max="20"></label>
        <label>X 间距 m<input id="ltAdx" type="number" value="1.2" step="0.05"></label><label>Y 间距 m<input id="ltAdy" type="number" value="1.2" step="0.05"></label></div>
        <div class="lt-btns"><button id="ltArr">生成阵列</button></div><div class="lt-note">沿 IFC X/Y 轴，从当前灯具开始；房间外位置自动跳过。</div></details>
      <div class="lt-derived">ID ${f.fixtureId}</div>`;
    box.querySelectorAll('input[data-path]').forEach(inp => inp.addEventListener('input', () => {
      const v = +inp.value; if (!Number.isFinite(v)) return;
      box.querySelectorAll(`input[data-path="${inp.dataset.path}"]`).forEach(o => { if (o !== inp) o.value = v; });
      this._editing = true; this.setField(inp.dataset.path, v); this._editing = false;
    }));
    $('#ltOn').onclick = () => this.setField('photometricParameters.on', !ph.on, false);
    $('#ltName').onchange = e => this.setField('name', e.target.value.trim() || f.name, false);
    $('#ltNotes').onchange = e => this.setField('notes', e.target.value, false);
    $('#ltSupply').onchange = e => this.setField('electrical', { ...(f.electrical || {}), supply: e.target.value || null }, false);
    $('#ltGroup').onchange = e => this.setField('electrical', { ...(f.electrical || {}), group: e.target.value.trim() || null }, false);
    ['ltPx', 'ltPy'].forEach((id, k) => $('#' + id).onchange = e => {
      const v = +e.target.value; if (!Number.isFinite(v)) return;
      const p = local.slice(0, 2); p[k] = this.plan.origin[k] + v / 1000;
      if (FIXTURE_TYPES[f.fixtureType].mount.includes('ceiling') && f.mountReference?.surface !== 'wall') this.moveFixtureToPlan(f.fixtureId, p);
      else this.setPositionAxis(k, this.frames.localToWorld([p[0], p[1], local[2]])[k]);
    });
    $('#ltMh').onchange = e => { const v = +e.target.value; if (v > 0 && v < 10) this.setMountHeight(v); else this.v.toast('安装高度应在 0–10 m'); };
    $('#ltDup').onclick = () => this.duplicate(); $('#ltDel').onclick = () => this.remove();
    $('#ltArr').onclick = () => this.array(+$('#ltAx').value, +$('#ltAy').value, +$('#ltAdx').value, +$('#ltAdy').value);
  }
}
