/* WEA Drafting — 2D reflected-ceiling-plan editor for precise fixture positioning (CAD-style).
 * An SVG drawing over the 3D viewport, in IFC local plan coordinates (m, X right, Y up; viewed from
 * above, same orientation as the floor plan). Edits go through the lighting workspace (same design
 * document, same undo stack), so the 3D preview and the illuminance follow every change.
 *   - reference linework (references.js): wall / column cut at +1.2 m, ceiling outlines, rooms, IfcGrid axes
 *   - object snaps, alignment tracking, ORTHO (F8 / Shift), module grid relative to the positioning origin
 *   - temporary dimensions to the nearest wall faces (or axes); click a dimension to type the distance
 *   - command line: x,y (absolute, mm from the origin) · @dx,dy · @d<angle · d (direct distance)
 */
import * as G from './geom2d.js';
import { planCut, ceilingEdges, gridLines } from './references.js';
import { roomAt } from '../room.js';

// design annotations: furniture / features the AI designer and the designer refer to (design data, not IFC)
export const ANNOTATION_KINDS = { sofa: '沙发', coffee_table: '茶几', tv: '电视墙', artwork: '挂画', dining_table: '餐桌', bed: '床', desk: '书桌', island: '岛台', plant: '绿植', other: '其他' };

const $ = s => document.querySelector(s);
const NS = 'http://www.w3.org/2000/svg';
const LAYERS = { wall: '墙 / 柱', other: '其他构件', ceiling: '吊顶边线', room: '房间', axis: '轴网' };
const SNAPS = { end: '端点', mid: '中点', int: '交点', perp: '垂足', near: '最近点', fixture: '灯具', track: '对齐追踪', grid: '模数', axis: '轴网' };
export const PLAN_DEFAULTS = {
  planOrigin: null,                       // IFC world [x, y] of the positioning origin; null = IFC project origin
  planStep: 0.05,                         // module grid, m
  planOrtho: false, planDimRef: 'wall',   // temporary dimensions measure to wall faces / ceiling edges ('wall') or grid axes ('axis')
  planSnap: { end: true, mid: true, int: true, perp: true, near: true, fixture: true, track: true, grid: true, axis: true },
  planLayers: { wall: true, other: true, ceiling: true, room: true, axis: true },
};
const DIM_KINDS = { wall: new Set(['wall', 'ceiling', 'room']), axis: new Set(['axis']) };

export class PlanView {
  constructor(ws) {
    this.ws = ws; this.v = ws.v; this.open = false; this.cache = new Map();
    this.view = { k: 60, x: 0, y: 0 }; this.cursor = null; this.snap = null; this.drag = null; this.measure = null; this.tool = null;
    this.root = $('#ltPlan'); this.svg = $('#ltPlanSvg');
    this.gWorld = this.el('g', {}, this.svg); this.gRefs = this.el('g', {}, this.gWorld); this.gGrid = this.el('g', {}, this.gWorld);
    this.gFix = this.el('g', {}, this.svg); this.gOver = this.el('g', {}, this.svg);
    this.wire();
  }
  get ds() { return this.ws.state.design.designerSettings; }
  get F() { return this.ws.frames; }
  el(tag, attrs, parent) { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); parent?.appendChild(e); return e; }

  /* ---------- coordinates ---------- */
  toScreen([x, y]) { return [x * this.view.k + this.view.x, -y * this.view.k + this.view.y]; }
  toPlan(cx, cy) { const r = this.svg.getBoundingClientRect(); return [(cx - r.left - this.view.x) / this.view.k, -(cy - r.top - this.view.y) / this.view.k]; }
  /** positioning origin in IFC local plan coordinates */
  get origin() { const o = this.ds.planOrigin; return o ? this.F.worldToLocal([o[0], o[1], 0]).slice(0, 2) : this.F.worldToLocal([0, 0, 0]).slice(0, 2); }
  fixturePlan(f) { return this.F.worldToLocal(f.position.ifcWorld).slice(0, 2); }

  /* ---------- lifecycle ---------- */
  show(room) {
    for (const [k, v] of Object.entries(PLAN_DEFAULTS)) if (this.ds[k] === undefined) this.ds[k] = JSON.parse(JSON.stringify(v));
    this.open = true; this.root.hidden = false; this.storey = null; document.body.classList.add('ws-plan');
    this.build(room); this.renderBar(); this.fit(room); this.renderFixtures();
  }
  hide() { this.open = false; this.root.hidden = true; document.body.classList.remove('ws-plan'); this.cancel(); $('#ltPlanCmd').hidden = true; $('#ltPlanDimEdit').hidden = true; }
  storeyOf(room) { return this.ws.rooms.filter(r => Math.abs(r.floor - room.floor) < 0.5); }
  build(room) {
    const key = room.floor.toFixed(2);
    if (this.storey?.key === key) return;
    let c = this.cache.get(key);
    if (!c) {
      const t0 = performance.now(), rooms = this.storeyOf(room), v = this.v, g = v.geometry;
      const box = rooms.reduce((b, r) => [Math.min(b[0], r.min[0]), Math.min(b[1], r.min[1]), Math.max(b[2], r.max[0]), Math.max(b[3], r.max[1])], [Infinity, Infinity, -Infinity, -Infinity]);
      const pad = [box[0] - 3, box[1] - 3, box[2] + 3, box[3] + 3];
      const floor = Math.min(...rooms.map(r => r.floor)), top = Math.max(...rooms.map(r => Math.max(r.top, r.ceiling ?? r.top)));
      const env = this.ws.envelopeActive ? this.ws.envelope.keep : null, include = env ? i => env.has(i) : null;   // interior envelope: no hidden studs / substrate lines
      const cut = planCut(g, v.elements, { z: floor + 1.2, box: pad, include });
      const ceil = ceilingEdges(g, v.elements, { zmin: floor + 1.9, zmax: top + 0.3, box: pad, include });
      const roomSegs = rooms.flatMap(r => [r.footprint, ...(r.holes || [])].flatMap(ring => ring.map((p, i) => ({ a: p, b: ring[(i + 1) % ring.length], kind: 'room', label: r.name }))));
      const level = v.model.levels?.[room.element.level]?.name || null;
      const axes = gridLines(v.model.grids, level);
      c = { key, rooms, box: pad, floor, segs: { wall: cut.filter(s => s.kind === 'wall'), other: cut.filter(s => s.kind === 'other'), ceiling: ceil, room: roomSegs, axis: axes },
        level, ms: performance.now() - t0 };
      this.cache.set(key, c);
    }
    this.storey = c; this.reindex(); this.renderRefs();
  }
  reindex() {
    const L = this.ds.planLayers, s = this.storey.segs;
    this.all = Object.keys(LAYERS).filter(k => L[k]).flatMap(k => s[k]);
    this.index = new G.SegmentIndex(this.all, 1);
  }
  fit(room = this.ws.room) {
    const r = this.svg.getBoundingClientRect(); if (!r.width) return;
    const b = room ? [room.min[0] - 1, room.min[1] - 1, room.max[0] + 1, room.max[1] + 1] : this.storey.box;
    const k = Math.min(r.width / (b[2] - b[0]), r.height / (b[3] - b[1])) * 0.92;
    this.view = { k, x: r.width / 2 - k * (b[0] + b[2]) / 2, y: r.height / 2 + k * (b[1] + b[3]) / 2 };
    this.applyView();
  }
  applyView() {
    const { k, x, y } = this.view;
    this.gWorld.setAttribute('transform', `matrix(${k} 0 0 ${-k} ${x} ${y})`); $('#ltPlanDimEdit').hidden = true;
    this.renderGrid(); this.renderFixtures(); this.renderOverlay();
  }

  /* ---------- drawing ---------- */
  renderRefs() {
    const g = this.gRefs; g.textContent = '';
    const style = { wall: ['#d9dcd8', 1.4], other: ['#7c858b', 0.8], ceiling: ['#5b93b8', 0.8, '5 3'], room: ['#b9cf72', 0.8, '2 3'], axis: ['#d35a4a', 0.8, '12 3 2 3'] };
    for (const [kind, segs] of Object.entries(this.storey.segs)) {
      if (!this.ds.planLayers[kind] || !segs.length) continue;
      const [color, w, dash] = style[kind];
      const d = segs.map(s => `M${s.a[0]} ${s.a[1]}L${s.b[0]} ${s.b[1]}`).join('');
      this.el('path', { d, stroke: color, 'stroke-width': w, fill: 'none', 'vector-effect': 'non-scaling-stroke', ...(dash ? { 'stroke-dasharray': dash } : {}) }, g);
    }
    const cur = this.ws.room;
    if (cur) this.el('path', { d: 'M' + cur.footprint.map(p => p.join(' ')).join('L') + 'Z', fill: '#d7f16b0d', stroke: 'none' }, g);
  }
  /** module grid dots (only when dense enough to read) + axis bubbles */
  renderGrid() {
    const g = this.gGrid; g.textContent = '';
    this.gOverAxis?.remove(); this.gOverAxis = this.el('g', {}, this.svg);
    if (this.ds.planLayers.axis) for (const s of this.storey.segs.axis) {
      if (!s.label) continue;
      for (const end of [s.a, s.b]) {
        const [x, y] = this.toScreen(end);
        this.el('circle', { cx: x, cy: y, r: 9, fill: '#16191d', stroke: '#d35a4a', 'stroke-width': 1 }, this.gOverAxis);
        const t = this.el('text', { x, y: y + 3.5, 'text-anchor': 'middle', class: 'pl-axis' }, this.gOverAxis); t.textContent = s.label;
      }
    }
  }
  renderFixtures() {
    if (!this.open) return;
    const g = this.gFix; g.textContent = '';
    const sel = this.ws.state.selectedId, types = this.ws.FIXTURE_TYPES;
    const board = this.ws.state.design.elvSettings?.board;
    if (board?.world) {                                                  // distribution board AL1
      const [x, y] = this.toScreen(this.F.worldToLocal([board.world[0], board.world[1], 0]).slice(0, 2));
      this.el('rect', { x: x - 12, y: y - 5, width: 24, height: 10, fill: '#e0505055', stroke: '#ff7a6a', 'stroke-width': 1.4 }, g);
      const t = this.el('text', { x: x + 15, y: y + 4, class: 'pl-ann' }, g); t.textContent = 'AL1 配电箱';
    }
    for (const a of this.annotations()) {                                // designer annotations (diamond + label)
      const [x, y] = this.toScreen(a.p);
      this.el('path', { d: `M${x} ${y - 7}L${x + 7} ${y}L${x} ${y + 7}L${x - 7} ${y}Z`, fill: '#8c7ff033', stroke: '#b3a8ff', 'stroke-width': 1.2 }, g);
      const t = this.el('text', { x: x + 10, y: y + 4, class: 'pl-ann' }, g); t.textContent = a.label;
    }
    for (const f of this.ws.state.fixtures) {
      const p = this.fixturePlan(f);
      if (!this.storey.rooms.some(r => r.id === f.roomId) && !this.inBox(p)) continue;
      const [x, y] = this.toScreen(p), on = f.photometricParameters.on, active = f.fixtureId === sel;
      const color = active ? '#d7f16b' : on ? '#ffd27a' : '#8a9096';
      const grp = this.el('g', { 'data-fixture': f.fixtureId, class: 'pl-fx' }, g);
      if (f.fixtureType === 'luminous') {                              // emitting faces projected to plan, hatched glow
        const g = this.ws.LUMINOUS?.get(f.fixtureId);
        if (g?.faces?.length) {
          const off = [p[0] - g.origin[0], p[1] - g.origin[1]];
          const d = g.faces.map(t => 'M' + [t.a, t.b, t.c].map(v => this.toScreen([v[0] + off[0], v[1] + off[1]]).join(' ')).join('L') + 'Z').join('');
          this.el('path', { d, fill: active ? '#d7f16b55' : on ? '#ffd27a44' : '#8a909633', stroke: color, 'stroke-width': 0.6 }, grp);
        }
        this.el('path', { d: `M${x} ${y - 8}L${x + 8} ${y}L${x} ${y + 8}L${x - 8} ${y}Z`, fill: '#16191d', stroke: color, 'stroke-width': 1.4 }, grp);
      } else if (f.fixtureType === 'linear') {
        const b = (f.rotation.bodyRotation || 0) * Math.PI / 180, L = (f.photometricParameters.length || 1) / 2, d = [Math.cos(b) * L, Math.sin(b) * L];
        const [a1, a2] = [this.toScreen([p[0] - d[0], p[1] - d[1]]), this.toScreen([p[0] + d[0], p[1] + d[1]])];
        this.el('line', { x1: a1[0], y1: a1[1], x2: a2[0], y2: a2[1], stroke: color, 'stroke-width': Math.max(3, 0.04 * this.view.k), 'stroke-linecap': 'butt' }, grp);
      } else if (f.fixtureType === 'ceiling') {                         // ceiling light to scale
        const r = Math.max(7, (f.photometricParameters.diameter || 0.4) / 2 * this.view.k);
        this.el('circle', { cx: x, cy: y, r, fill: '#16191d99', stroke: color, 'stroke-width': 1.4 }, grp);
        this.el('circle', { cx: x, cy: y, r: 2.5, fill: color }, grp);
      } else if (f.fixtureType === 'pendant') {                         // shade to scale + canopy
        const r = Math.max(8, (f.photometricParameters.diameter || 0.5) / 2 * this.view.k);
        this.el('circle', { cx: x, cy: y, r, fill: '#16191d99', stroke: color, 'stroke-width': 1.4 }, grp);
        this.el('circle', { cx: x, cy: y, r: r * 0.45, fill: 'none', stroke: color, 'stroke-width': 1 }, grp);
        this.el('path', { d: `M${x - r} ${y}H${x + r}M${x} ${y - r}V${y + r}`, stroke: color, 'stroke-width': 0.8 }, grp);
      } else {
        this.el('circle', { cx: x, cy: y, r: 6.5, fill: '#16191d', stroke: color, 'stroke-width': 1.6 }, grp);
        this.el('path', { d: `M${x - 9} ${y}H${x + 9}M${x} ${y - 9}V${y + 9}`, stroke: color, 'stroke-width': 1 }, grp);
        if (f.fixtureType === 'spotlight' && f.rotation.aimTilt > 1) {
          const az = (f.rotation.aimAzimuth || 0) * Math.PI / 180;
          this.el('path', { d: `M${x} ${y}l${Math.cos(az) * 18} ${-Math.sin(az) * 18}`, stroke: color, 'stroke-width': 1.4, 'marker-end': 'url(#plArrow)' }, grp);
        }
      }
      this.el('circle', { cx: x, cy: y, r: 11, fill: 'transparent' }, grp);       // generous hit area
      if (this.view.k > 45) { const t = this.el('text', { x: x + 10, y: y - 9, class: 'pl-fx-name' + (active ? ' active' : '') }, grp); t.textContent = f.name; }
    }
  }
  annotations() {
    const all = this.ws.state.design.roomAnnotations || {}, ids = new Set(this.storey.rooms.map(r => r.id));
    return Object.entries(all).filter(([id]) => ids.has(id)).flatMap(([roomId, list]) => list.map(a => ({ ...a, roomId, p: this.F.worldToLocal([a.world[0], a.world[1], 0]).slice(0, 2) })));
  }
  inBox(p) { const b = this.storey.box; return p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3]; }

  /** cursor marker, guides, temporary dimensions, measurement */
  renderOverlay() {
    const g = this.gOver; g.textContent = '';
    if (!this.open) return;
    const o = this.toScreen(this.origin);                                  // positioning origin (UCS) marker
    this.el('path', { d: `M${o[0]} ${o[1]}h26M${o[0]} ${o[1]}v-26`, stroke: '#e8e8e8', 'stroke-width': 1.2, 'marker-end': 'url(#plArrow)' }, g);
    this.el('rect', { x: o[0] - 3, y: o[1] - 3, width: 6, height: 6, fill: 'none', stroke: '#e8e8e8' }, g);
    const lab = this.el('text', { x: o[0] + 5, y: o[1] + 13, class: 'pl-small' }, g); lab.textContent = this.ds.planOrigin ? '定位原点' : '项目原点';
    // the point being positioned: dragged fixture / placement cursor / selected fixture
    const sel = this.ws.state.selected;
    const active = this.drag ? this.drag.point : (this.tool === 'add' && this.snap) ? this.snap.point : sel ? this.fixturePlan(sel) : null;
    if (active) this.renderDims(active, !this.drag && this.tool !== 'add' && sel);
    if (this.snap && this.cursor) {
      for (const [a, b] of this.snap.guides) { const [p, q] = [this.toScreen(a), this.toScreen(b)]; this.el('line', { x1: p[0], y1: p[1], x2: q[0], y2: q[1], class: 'pl-guide' }, g); }
      const [x, y] = this.toScreen(this.snap.point), k = this.snap.kind;
      const mark = { end: `M${x - 5} ${y - 5}h10v10h-10z`, int: `M${x - 6} ${y - 6}L${x + 6} ${y + 6}M${x + 6} ${y - 6}L${x - 6} ${y + 6}`, mid: `M${x} ${y - 7}L${x + 6} ${y + 4}H${x - 6}Z`,
        perp: `M${x - 6} ${y + 5}H${x + 6}M${x - 3} ${y + 5}V${y - 7}`, near: `M${x - 5} ${y - 5}L${x + 5} ${y + 5}H${x - 5}L${x + 5} ${y - 5}Z`, fixture: `M${x - 7} ${y}a7 7 0 1 0 14 0a7 7 0 1 0 -14 0`, origin: `M${x - 6} ${y - 6}h12v12h-12z` }[k]
        || `M${x - 4} ${y}H${x + 4}M${x} ${y - 4}V${y + 4}`;
      this.el('path', { d: mark, class: 'pl-snap' }, g);
      const rel = G.sub(this.snap.point, this.origin);
      const tip = this.el('text', { x: x + 12, y: y + 20, class: 'pl-tip' }, g);
      tip.textContent = `${this.snap.label ? this.snap.label + '  ' : ''}X ${G.mm(rel[0])}  Y ${G.mm(rel[1])}`;
    }
    if (this.measure?.a) {
      const a = this.measure.a, b = this.measure.b || this.snap?.point; if (b) this.dimLine(a, b, G.dist(a, b), g, 'pl-measure', 14);
    }
    this.renderStatus();
  }
  /** temporary dimensions of point p to the nearest targets left / right / below / above */
  renderDims(p, editable) {
    const kinds = DIM_KINDS[this.ds.planDimRef] || DIM_KINDS.wall;
    const targets = this.all.filter(s => kinds.has(s.kind));
    const c = G.clearances(p, targets, 40);
    for (const [name, h] of Object.entries(c)) {
      const t = this.dimLine(p, h.hit, h.d, this.gOver, 'pl-dim', 0);
      if (editable && t) { t.classList.add('editable'); t.onclick = e => { e.stopPropagation(); this.editDim(name, h, t); }; }
    }
  }
  dimLine(a, b, value, g, cls, offsetPx) {
    let [p, q] = [this.toScreen(a), this.toScreen(b)];
    const L = Math.hypot(q[0] - p[0], q[1] - p[1]); if (L < 14) return null;
    const n = [-(q[1] - p[1]) / L, (q[0] - p[0]) / L];
    if (offsetPx) { p = [p[0] + n[0] * offsetPx, p[1] + n[1] * offsetPx]; q = [q[0] + n[0] * offsetPx, q[1] + n[1] * offsetPx]; }
    this.el('line', { x1: p[0], y1: p[1], x2: q[0], y2: q[1], class: cls }, g);
    for (const e of [p, q]) this.el('line', { x1: e[0] - n[0] * 4 - (q[0] - p[0]) / L * 3, y1: e[1] - n[1] * 4 - (q[1] - p[1]) / L * 3, x2: e[0] + n[0] * 4 + (q[0] - p[0]) / L * 3, y2: e[1] + n[1] * 4 + (q[1] - p[1]) / L * 3, class: cls + '-tick' }, g);
    const m = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2], vertical = Math.abs(q[0] - p[0]) < Math.abs(q[1] - p[1]);
    const t = this.el('text', { x: m[0] + (vertical ? 5 : 0), y: m[1] + (vertical ? 4 : -5), 'text-anchor': vertical ? 'start' : 'middle', class: cls + '-text' }, g);
    t.textContent = G.mm(value);
    return t;
  }
  renderStatus() {
    const sel = this.ws.state.selected, st = $('#ltPlanStatus');
    const rel = this.cursor ? G.sub(this.snap?.point || this.cursor, this.origin) : null;
    const hint = this.tool === 'board' ? '单击墙边位置放置照明配电箱 AL1（强电回路起点）' : this.tool === 'annotate' ? '单击放置标注（右侧选择类型）；单击已有标注删除' : this.tool === 'add' ? `放置 ${this.ws.FIXTURE_TYPES[this.ws.addType].label}：单击放置，或直接输入坐标` : this.tool === 'origin' ? '单击一个捕捉点作为定位原点（Esc 取消）'
      : this.tool === 'measure' ? (this.measure?.a ? '单击第二点' : '单击第一点') : sel ? `已选 ${sel.name}：拖动移动 · 点尺寸数字直接输入 · 键入 @dx,dy 相对移动` : '单击选择灯具 · 拖动空白处平移 · 滚轮缩放';
    st.innerHTML = `<span>${this.v.safe(hint)}</span><b>${rel ? `X ${G.mm(rel[0])}　Y ${G.mm(rel[1])} mm` : ''}</b><em>${this.ds.planOrtho ? '正交 ON' : ''}</em>`;
  }

  /* ---------- toolbar ---------- */
  renderBar() {
    const ds = this.ds, bar = $('#ltPlanBar');
    const toggles = (obj, labels, attr) => Object.entries(labels).map(([k, l]) => `<button data-${attr}="${k}" class="${obj[k] ? 'active' : ''}">${l}</button>`).join('');
    bar.innerHTML = `
      <div class="seg"><button data-pl-tool="annotate" class="${this.tool === 'annotate' ? 'active' : ''}" title="标出沙发、茶几、挂画等位置，供 AI 设计师与布灯参考；在已有标注上单击可删除">标注</button></div>
      <select id="plAnnKind" class="pl-ann-kind" ${this.tool === 'annotate' ? '' : 'hidden'}>${Object.entries(ANNOTATION_KINDS).map(([k, l]) => `<option value="${k}" ${k === (this.annKind || 'coffee_table') ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <div class="seg"><button data-pl-tool="board" class="${this.tool === 'board' ? 'active' : ''}" title="指定照明配电箱 AL1 的位置（强电回路从这里出线）；未指定时出图自动放在入户门旁">配电箱</button></div>
      <div class="seg"><button data-pl-tool="origin" class="${this.tool === 'origin' ? 'active' : ''}" title="点选墙角或轴线交点作为定位原点">设原点</button><button data-pl-tool="origin-reset" title="恢复为 IFC 项目原点">项目原点</button><button data-pl-tool="measure" class="${this.tool === 'measure' ? 'active' : ''}">测量</button></div>
      <div class="seg pl-snaps" title="对象捕捉（按住 Alt 临时关闭）">${toggles(ds.planSnap, SNAPS, 'pl-snap')}</div>
      <label class="pl-step">模数 <select id="plStep">${[0, 0.01, 0.05, 0.1, 0.3, 0.6].map(v => `<option value="${v}" ${v === ds.planStep ? 'selected' : ''}>${v ? v * 1000 + ' mm' : '关'}</option>`).join('')}</select></label>
      <div class="seg"><button data-pl-ortho class="${ds.planOrtho ? 'active' : ''}" title="F8；按住 Shift 临时正交">正交</button></div>
      <label class="pl-step">尺寸参照 <select id="plDimRef"><option value="wall" ${ds.planDimRef === 'wall' ? 'selected' : ''}>墙面 / 吊顶边</option><option value="axis" ${ds.planDimRef === 'axis' ? 'selected' : ''}>轴线</option></select></label>
      <details class="pl-layers"><summary>图层</summary>${toggles(ds.planLayers, LAYERS, 'pl-layer')}</details>
      <div class="seg"><button id="plFit" title="双击空白处同样适应">适应房间</button></div>`;
    bar.querySelectorAll('[data-pl-snap]').forEach(b => b.onclick = () => { ds.planSnap[b.dataset.plSnap] = !ds.planSnap[b.dataset.plSnap]; this.renderBar(); });
    bar.querySelectorAll('[data-pl-layer]').forEach(b => b.onclick = () => { ds.planLayers[b.dataset.plLayer] = !ds.planLayers[b.dataset.plLayer]; this.reindex(); this.renderRefs(); this.renderGrid(); this.renderBar(); bar.querySelector('.pl-layers').open = true; });
    bar.querySelector('[data-pl-ortho]').onclick = () => this.toggleOrtho();
    $('#plStep').onchange = e => { ds.planStep = +e.target.value; };
    $('#plDimRef').onchange = e => { ds.planDimRef = e.target.value; this.renderOverlay(); };
    $('#plFit').onclick = () => this.fit();
    bar.querySelector('[data-pl-tool="origin"]').onclick = () => this.setTool(this.tool === 'origin' ? null : 'origin');
    bar.querySelector('[data-pl-tool="board"]').onclick = () => this.setTool(this.tool === 'board' ? null : 'board');
    bar.querySelector('[data-pl-tool="annotate"]').onclick = () => this.setTool(this.tool === 'annotate' ? null : 'annotate');
    $('#plAnnKind').onchange = e => { this.annKind = e.target.value; };
    bar.querySelector('[data-pl-tool="measure"]').onclick = () => { this.measure = null; this.setTool(this.tool === 'measure' ? null : 'measure'); };
    bar.querySelector('[data-pl-tool="origin-reset"]').onclick = () => { ds.planOrigin = null; this.ws.state.dirty = true; this.renderOverlay(); this.ws.renderInspector(); this.v.toast('定位原点恢复为 IFC 项目原点'); };
  }
  setTool(t) { this.tool = t; this.renderBar(); this.renderOverlay(); }
  toggleOrtho() { this.ds.planOrtho = !this.ds.planOrtho; this.renderBar(); this.renderOverlay(); }
  /** the plan tool in effect: own tools (origin / measure) first, then the workspace tool */
  get mode() { return this.tool || (this.ws.tool === 'add' ? 'add' : 'select'); }

  /* ---------- snapping ---------- */
  snapAt(p, { base = null, exclude = null, alt = false, shift = false } = {}) {
    const ds = this.ds;
    const fixtures = this.ws.state.fixtures.filter(f => f.fixtureId !== exclude).map(f => ({ p: this.fixturePlan(f), kind: 'fixture', label: f.name }));
    const tol = 10 / this.view.k;
    if (alt) return { point: p, kind: 'free', label: '', guides: [] };
    return G.snapPoint(p, { index: this.index, points: ds.planSnap.fixture ? fixtures : [], tracks: [...fixtures, ...(base ? [{ p: base, label: '基点' }] : [])], base, origin: this.origin },
      { tol, step: ds.planSnap.grid ? ds.planStep : 0, ortho: ds.planOrtho || shift, modes: { ...ds.planSnap, geom: true } });
  }

  /* ---------- interaction ---------- */
  wire() {
    const svg = this.svg;
    svg.addEventListener('wheel', e => {
      e.preventDefault();
      const r = svg.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top, f = Math.exp(-e.deltaY * 0.0015), v = this.view;
      const k = Math.min(Math.max(v.k * f, 2), 4000);
      v.x = mx - (mx - v.x) * k / v.k; v.y = my - (my - v.y) * k / v.k; v.k = k; this.applyView();
    }, { passive: false });
    svg.addEventListener('pointerdown', e => {
      if (e.target.closest?.('.editable')) return;                 // dimension text: its own click handler edits it
      $('#ltPlanDimEdit').hidden = true;
      svg.setPointerCapture(e.pointerId);
      const p = this.toPlan(e.clientX, e.clientY), mode = this.mode;
      if (e.button === 1 || e.button === 2) { this.pan = { x: e.clientX, y: e.clientY }; return; }
      if (mode !== 'select') { this.down = { x: e.clientX, y: e.clientY, click: true }; return; }
      const id = e.target.closest?.('[data-fixture]')?.dataset.fixture;
      if (id) {
        this.ws.state.select(id);
        const f = this.ws.state.fixture(id), start = this.fixturePlan(f);
        this.drag = { id, start, grab: G.sub(p, start), point: start, moved: false, x: e.clientX, y: e.clientY };
      } else this.pan = { x: e.clientX, y: e.clientY, click: true, sx: e.clientX, sy: e.clientY };
    });
    svg.addEventListener('pointermove', e => {
      const p = this.toPlan(e.clientX, e.clientY); this.cursor = p;
      if (this.pan) { this.view.x += e.clientX - this.pan.x; this.view.y += e.clientY - this.pan.y; this.pan.x = e.clientX; this.pan.y = e.clientY; this.applyView(); return; }
      if (this.drag) {
        if (!this.drag.moved && Math.hypot(e.clientX - this.drag.x, e.clientY - this.drag.y) < 4) return;
        this.drag.moved = true;
        this.snap = this.snapAt(G.sub(p, this.drag.grab), { base: this.drag.start, exclude: this.drag.id, alt: e.altKey, shift: e.shiftKey });
        this.drag.point = this.snap.point; this.renderOverlay(); this.renderDragGhost(); return;
      }
      const base = this.mode === 'measure' ? this.measure?.a : this.mode === 'add' ? this.lastPoint : null;
      this.snap = this.snapAt(p, { base, alt: e.altKey, shift: e.shiftKey }); this.renderOverlay();
    });
    svg.addEventListener('pointerup', e => {
      const pan = this.pan; this.pan = null;
      if (this.drag) {
        const d = this.drag; this.drag = null; this.ghost?.remove();
        if (d.moved) this.ws.moveFixtureToPlan(d.id, d.point);
        this.renderOverlay(); return;
      }
      if (pan) { if (pan.click && Math.hypot(e.clientX - pan.sx, e.clientY - pan.sy) < 4 && e.button === 0) { this.ws.state.select(null); } return; }
      if (!this.down) return;
      this.down = null;
      const pt = (this.snap || { point: this.toPlan(e.clientX, e.clientY) }).point;
      this.clickAt(pt);
    });
    svg.addEventListener('dblclick', e => { if (!e.target.closest('[data-fixture]')) this.fit(); });
    svg.addEventListener('contextmenu', e => e.preventDefault());
    svg.addEventListener('pointerleave', () => { this.cursor = null; this.snap = null; this.renderOverlay(); });
    new ResizeObserver(() => this.open && this.applyView()).observe(svg);
    // command line: typing a number / @ starts coordinate entry
    window.addEventListener('keydown', e => {
      if (!this.open || e.target.closest('input,textarea,select')) return;
      if (e.key === 'F8') { e.preventDefault(); this.toggleOrtho(); return; }
      if (e.key === 'Escape') { this.cancel(); return; }
      if (/^[0-9@\-]$/.test(e.key) && !e.metaKey && !e.ctrlKey) { e.preventDefault(); this.openCommand(e.key); }
    });
    const cmd = $('#ltPlanCmdInput');
    cmd.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); this.runCommand(cmd.value); }
      else if (e.key === 'Escape') { $('#ltPlanCmd').hidden = true; }
    });
    const dimIn = $('#ltPlanDimInput');
    dimIn.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); this.applyDim(+dimIn.value / 1000); }
      else if (e.key === 'Escape') $('#ltPlanDimEdit').hidden = true;
    });
  }
  renderDragGhost() {
    this.ghost?.remove(); const [x, y] = this.toScreen(this.drag.point);
    this.ghost = this.el('circle', { cx: x, cy: y, r: 7, fill: 'none', stroke: '#d7f16b', 'stroke-dasharray': '3 2', 'stroke-width': 1.4 }, this.gOver);
  }
  cancel() {
    this.drag = null; this.measure = null; this.tool = null; this.lastPoint = null; $('#ltPlanCmd').hidden = true; $('#ltPlanDimEdit').hidden = true;
    if (this.open) { this.renderBar(); this.renderOverlay(); }
  }
  clickAt(pt) {
    const mode = this.mode;
    if (mode === 'origin') {
      const w = this.F.localToWorld([pt[0], pt[1], 0]);
      this.ds.planOrigin = [Math.round(w[0] * 1e5) / 1e5, Math.round(w[1] * 1e5) / 1e5]; this.ws.state.dirty = true;
      this.tool = null; this.renderBar(); this.renderOverlay(); this.ws.renderInspector(); this.ws.renderScheme();
      this.v.toast(`定位原点已设在${this.snap?.label ? '「' + this.snap.label + '」' : '所选点'}`); return;
    }
    if (mode === 'board') {                                              // distribution board AL1 (design data, used by MEP Routing)
      const w = this.F.localToWorld([pt[0], pt[1], 0]);
      this.ws.state.commit('board', d => { d.elvSettings = { ...(d.elvSettings || {}), board: { world: [Math.round(w[0] * 1e5) / 1e5, Math.round(w[1] * 1e5) / 1e5] } }; });
      this.tool = null; this.renderBar(); this.v.toast('配电箱 AL1 位置已指定（MEP Routing 出图使用）'); return;
    }
    if (mode === 'annotate') {
      const near = this.annotations().find(a => G.dist(a.p, pt) < 12 / this.view.k);
      const room = roomAt(this.storey.rooms, pt[0], pt[1]);
      if (near) { this.ws.state.commit('remove annotation', d => { d.roomAnnotations[near.roomId] = d.roomAnnotations[near.roomId].filter(a => a.id !== near.id); }); return; }
      if (!room) { this.v.toast('标注需放在房间内'); return; }
      const kind = this.annKind || 'coffee_table', w = this.F.localToWorld([pt[0], pt[1], 0]);
      this.ws.state.commit('annotate', d => { d.roomAnnotations ||= {}; (d.roomAnnotations[room.id] ||= []).push({ id: Math.random().toString(36).slice(2, 9), kind, label: ANNOTATION_KINDS[kind], world: [w[0], w[1]] }); });
      this.v.toast(`已在「${room.name}」标注${ANNOTATION_KINDS[kind]}`); return;
    }
    if (mode === 'measure') {
      if (!this.measure?.a || this.measure.b) this.measure = { a: pt };
      else { this.measure.b = pt; const d = G.sub(pt, this.measure.a); this.v.toast(`距离 ${G.mm(Math.hypot(...d))} mm（ΔX ${G.mm(d[0])} · ΔY ${G.mm(d[1])}）`); }
      this.renderOverlay(); return;
    }
    if (mode === 'add') { if (this.ws.addFixtureAtPlan(pt)) this.lastPoint = pt; }
  }

  /* ---------- typed input ---------- */
  openCommand(first) {
    const box = $('#ltPlanCmd'), inp = $('#ltPlanCmdInput');
    box.hidden = false; inp.value = first; inp.focus();
    const sel = this.ws.state.selected;
    $('#ltPlanCmdHint').textContent = this.mode === 'add' ? '放置：x,y（相对定位原点，mm） · @dx,dy（相对上一盏） · @距离<角度'
      : sel ? `移动 ${sel.name}：x,y（相对定位原点） · @dx,dy · @距离<角度 · 单个数值 = 沿光标方向的距离` : '先选择一盏灯具，或切换到“添加”工具';
  }
  runCommand(text) {
    const c = G.parseCoordinate(text), sel = this.ws.state.selected, mode = this.mode;
    if (!c) { this.v.toast('无法识别的坐标：' + text); return; }
    const base = mode === 'add' ? (this.lastPoint || (sel ? this.fixturePlan(sel) : null)) : sel ? this.fixturePlan(sel) : null;
    let target;
    if (c.distance !== undefined) {
      if (!base || !this.cursor) { this.v.toast('单个数值表示沿光标方向的距离：需要基点（选中的灯具）'); return; }
      let dir = G.sub(this.snap?.point || this.cursor, base);
      if (this.ds.planOrtho) dir = Math.abs(dir[0]) >= Math.abs(dir[1]) ? [Math.sign(dir[0]) || 1, 0] : [0, Math.sign(dir[1]) || 1];
      const L = Math.hypot(...dir); if (L < 1e-9) { this.v.toast('请先把光标移向目标方向'); return; }
      target = G.add(base, G.mul(dir, c.distance / L));
    } else if (c.relative) {
      if (!base) { this.v.toast('相对坐标需要基点：先选择或放置一盏灯具'); return; }
      target = G.add(base, c.value);
    } else target = G.add(this.origin, c.value);
    $('#ltPlanCmd').hidden = true;
    if (mode === 'add') { if (this.ws.addFixtureAtPlan(target)) this.lastPoint = target; }
    else if (sel) this.ws.moveFixtureToPlan(sel.fixtureId, target);
    else this.v.toast('先选择一盏灯具');
  }
  editDim(name, hit, textEl) {
    const box = $('#ltPlanDimEdit'), inp = $('#ltPlanDimInput'), r = textEl.getBoundingClientRect(), host = this.root.getBoundingClientRect();
    this.dimEdit = { name, hit };
    box.style.left = (r.left - host.left - 10) + 'px'; box.style.top = (r.top - host.top - 6) + 'px';
    box.hidden = false; inp.value = Math.round(hit.d * 1000); inp.select(); inp.focus();
  }
  /** keep the reference (wall / axis) fixed, move the fixture so that this distance becomes `value` */
  applyDim(value) {
    const sel = this.ws.state.selected, e = this.dimEdit; $('#ltPlanDimEdit').hidden = true;
    if (!sel || !e || !(value >= 0)) return;
    const dir = G.DIRS[e.name], p = this.fixturePlan(sel);
    this.ws.moveFixtureToPlan(sel.fixtureId, G.add(p, G.mul(dir, e.hit.d - value)));
  }
}
