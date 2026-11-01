/* WEA AI — tools the designer agent can call (provider-neutral function-calling definitions + executor).
 * The agent decides; WEA's deterministic code places, calculates and checks. Rules enforced here, not
 * in the prompt:
 *   - writes only go to schemes created by the agent in this session (drafts); existing schemes are read-only
 *   - every fixture is validated (photometry.validateFixture) and must mount on a real ceiling found
 *     by ray cast in the BIM geometry; failures are returned to the agent, never silently fixed
 *   - illuminance comes from photometry.js (same as the workspace estimate), criteria from standards.js
 * Coordinates for the agent: millimetres in the room frame (origin = room bbox min corner, x = +IFC X
 * (east if not rotated), y = +IFC Y), heights in mm above the room floor.
 */
import * as P from '../lighting/photometry.js';
import { FIXTURE_TYPES, newFixtureId, mountDrop } from '../lighting/catalog.js';
import { addScheme } from '../lighting/state.js';
import { STANDARD, roomType, designTargets, checkTargets, parseStyles } from './standards.js';
import { roomWalls, visualCenter, gridLayout, alongWall, snapPoints, aimAt, toRoomMM, fromRoomMM, bbox } from './layout.js';
import { roomObjects, annotationObjects, OBJECT_KINDS } from './context.js';
import { designRooms, isContainerSpace } from '../lighting/room.js';

const FIX_PARAMS = {
  flux_lm: { type: 'number', description: '光通量 lm' }, power_w: { type: 'number', description: '功率 W（缺省按灯型光效由光通量换算）' },
  beam_deg: { type: 'number', description: `光束角 °（${P.BEAM_MIN}–${P.BEAM_MAX}）` }, cct_k: { type: 'number', description: '色温 K' },
  dimming_pct: { type: 'number', description: '调光 %' }, tilt_deg: { type: 'number', description: '射灯倾斜角，0 = 垂直向下' },
  azimuth_deg: { type: 'number', description: '射灯平面方位，0 = +x，90 = +y' }, suspension_mm: { type: 'number', description: '吊灯吊杆长度（天花到发光中心）' },
  diameter_mm: { type: 'number', description: '吊灯灯罩直径' }, up_ratio: { type: 'number', description: '吊灯上照光通比例 0–1' },
  length_mm: { type: 'number', description: '线性灯长度' }, rotation_deg: { type: 'number', description: '线性灯方向，0 = 沿 x' },
};
const ID = { type: 'string' }, MM = { type: 'number' };
const PLACEABLE = Object.entries(FIXTURE_TYPES).filter(([, t]) => !t.assignOnly);    // luminous surfaces are assigned to BIM elements, not placed
const TYPE = { type: 'string', enum: PLACEABLE.map(([k]) => k), description: PLACEABLE.map(([k, t]) => `${k}=${t.label}`).join('，') };
const RULE = { type: 'string', enum: ['half', 'equal', 'ends', 'margin'], description: 'half：端距=间距/2（常用）；equal：端距=间距；ends：首尾在端点；margin：指定端距' };
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const ROOMS = { type: 'array', items: { type: 'string' }, description: '房间 id 列表；["all"] 表示全部可设计房间（自动排除整户空间与面积 < 1 m² 的空间）' };

export const TOOL_DEFS = [
  { name: 'get_project_overview', description: '项目概况：模型、楼层、房间（id、名称、面积、类型、已有灯具数）、现有方案。', parameters: obj({}) },
  { name: 'get_room_context', description: '房间详情：尺寸、地面与天花高度（实测，含跌级覆盖率）、墙面（编号、长度、朝向）、可识别的家具与设计师标注、当前方案中的灯具。坐标为房间毫米坐标。',
    parameters: obj({ room_id: ID }, ['room_id']) },
  { name: 'get_design_targets', description: '查标准与风格目标：GB 50034 照度标准值、功率密度限值，以及风格词（明亮、温馨、柔和、氛围、现代、简约、清爽、高级）对应的设计目标。',
    parameters: obj({ room_id: ID, styles: { type: 'array', items: { type: 'string' } } }, ['room_id']) },
  { name: 'list_fixture_types', description: '可用灯型、默认参数与参数范围（通用模拟灯具，无厂家光度数据）。', parameters: obj({}) },
  { name: 'create_scheme', description: '新建一个草稿方案（AI 只能修改自己新建的方案），并记录任务书与所设计房间的目标。方案是整栋建筑级别的：从当前方案复制全部灯具；单个房间（room_id）默认清空该房间重新设计，多个房间（room_ids）默认保留已有灯具（replace_existing 可改）。可用 target_overrides 有理由地调整本方案目标（例如分层照明不以均匀度为目标；U0_min 设为 null 表示不考核）。返回 scheme_id。',
    parameters: obj({ name: { type: 'string' }, room_id: ID, room_ids: ROOMS, replace_existing: { type: 'boolean' }, brief: { type: 'string' }, styles: { type: 'array', items: { type: 'string' } },
      target_overrides: obj({ Eavg_min: MM, Eavg_max: MM, U0_min: { type: ['number', 'null'] }, reason: { type: 'string' } }, ['reason']) }, ['name']) },
  { name: 'place_in_rooms', description: '批量：在多个房间各放一盏灯（目前位置为房间视觉中心），适合“每个房间中心一个灯”。逐个房间报告放置、跳过与失败原因。',
    parameters: obj({ scheme_id: ID, rooms: ROOMS, type: TYPE, position: { type: 'string', enum: ['center'] }, skip_rooms_with_fixtures: { type: 'boolean' }, min_area_m2: MM, ...FIX_PARAMS }, ['scheme_id', 'rooms', 'type']) },
  { name: 'place_fixtures', description: '在指定房间毫米坐标放置灯具（吸顶 / 吊装自动找到正上方天花）。可选 aim_at 让射灯对准一个点或对象。',
    parameters: obj({ scheme_id: ID, room_id: ID, snap_mm: { type: 'number', description: '坐标取整模数，默认 50' },
      fixtures: { type: 'array', items: obj({ type: TYPE, x_mm: MM, y_mm: MM, name: { type: 'string' }, aim_at: obj({ object_id: ID, x_mm: MM, y_mm: MM, z_mm: MM }), ...FIX_PARAMS }, ['type', 'x_mm', 'y_mm']) } },
    ['scheme_id', 'room_id', 'fixtures']) },
  { name: 'layout_grid', description: '在房间（或其中一个矩形区域）内按行×列均布灯具，间距规则可选；L 形房间中落在房间外的点会被跳过并报告。',
    parameters: obj({ scheme_id: ID, room_id: ID, type: TYPE, rows: { type: 'integer' }, cols: { type: 'integer' }, rule: RULE, margin_mm: MM, inset_mm: { type: 'number', description: '矩形距墙内缩' },
      area: obj({ x0_mm: MM, y0_mm: MM, x1_mm: MM, y1_mm: MM }, ['x0_mm', 'y0_mm', 'x1_mm', 'y1_mm']), snap_mm: MM, ...FIX_PARAMS }, ['scheme_id', 'room_id', 'type', 'rows', 'cols']) },
  { name: 'layout_along_wall', description: '沿某面墙（get_room_context 的 wall_index）离墙 offset_mm 布置 count 盏，均分。aim=wall 时射灯朝该墙倾斜（洗墙 / 照亮墙面）。',
    parameters: obj({ scheme_id: ID, room_id: ID, wall_index: { type: 'integer' }, type: TYPE, count: { type: 'integer' }, offset_mm: MM, rule: RULE, margin_mm: MM, end_clear_mm: MM,
      aim: { type: 'string', enum: ['down', 'wall', 'away'] }, snap_mm: MM, ...FIX_PARAMS }, ['scheme_id', 'room_id', 'wall_index', 'type', 'count', 'offset_mm']) },
  { name: 'place_over_object', description: '把一盏灯放在对象（object_id，来自 get_room_context）正上方，或 room_center（房间视觉中心）。常用于吊灯 / 餐桌灯。',
    parameters: obj({ scheme_id: ID, room_id: ID, type: TYPE, target: ID, ...FIX_PARAMS }, ['scheme_id', 'room_id', 'type', 'target']) },
  { name: 'update_fixtures', description: '修改灯具参数或位置偏移；fixture_ids 为空表示该房间本方案的全部灯具，可用 filter_type 限定灯型。',
    parameters: obj({ scheme_id: ID, room_id: ID, fixture_ids: { type: 'array', items: ID }, filter_type: TYPE, move_mm: obj({ dx: MM, dy: MM }), ...FIX_PARAMS }, ['scheme_id', 'room_id']) },
  { name: 'remove_fixtures', description: '删除灯具。', parameters: obj({ scheme_id: ID, fixture_ids: { type: 'array', items: ID } }, ['scheme_id', 'fixture_ids']) },
  { name: 'evaluate_scheme', description: '实时照度估算（直接光、通用配光，未计遮挡与反射）：Eavg / Emin / Emax / U0、功率密度、色温，并与该方案记录的目标比对，逐项给出是否达标。不给 room_id 时汇总本方案设计的全部房间。',
    parameters: obj({ scheme_id: ID, room_id: ID }, ['scheme_id']) },
  { name: 'finalize_scheme', description: '完成方案：写入设计说明、假设与计算结果，供设计师在面板中打开、比较、出图。不给 room_id 时按本方案设计的全部房间汇总。',
    parameters: obj({ scheme_id: ID, room_id: ID, title: { type: 'string' }, rationale: { type: 'string' }, assumptions: { type: 'array', items: { type: 'string' } } }, ['scheme_id', 'rationale']) },
];

class ToolError extends Error {}
const fail = msg => { throw new ToolError(msg); };
const r1 = v => Math.round(v * 10) / 10;

export class DesignTools {
  /** ws: LightingWorkspace; source: 'ai' | 'demo' (stored on created schemes) */
  constructor(ws, { source = 'ai', onEvent = () => {} } = {}) {
    this.ws = ws; this.source = source; this.own = new Set(); this.onEvent = onEvent;
  }
  get design() { return this.ws.state.design; }
  get frames() { return this.ws.frames; }

  async call(name, args = {}) {
    if (!TOOL_DEFS.some(t => t.name === name)) return { ok: false, error: `未知工具 ${name}` };
    try {
      const result = await this[name](args || {});
      return { ok: true, ...result };
    } catch (err) {
      if (err instanceof ToolError) return { ok: false, error: err.message };
      console.error(err); return { ok: false, error: '内部错误：' + err.message };
    }
  }

  /* ---------- lookups ---------- */
  room(id) {
    const r = this.ws.roomById(id) || this.ws.rooms.find(x => x.name === id);
    return r || fail(`房间 ${id} 不存在；请先调用 get_project_overview`);
  }
  /** room list from ids / names, or ["all"] = rooms a designer would light */
  roomsFor(spec) {
    const list = Array.isArray(spec) ? spec : [spec];
    if (!list.length) fail('房间列表为空');
    if (list.includes('all')) return designRooms(this.ws.rooms);
    return list.map(id => this.room(id));
  }
  scheme(id, write = false) {
    const s = this.design.schemes[id]; if (!s) fail(`方案 ${id} 不存在`);
    if (write && !this.own.has(id)) fail(`方案 ${id} 不是本次 AI 新建的草稿，不能修改；请用 create_scheme 新建`);
    return s;
  }
  objectsIn(room) {
    const ann = (this.design.roomAnnotations?.[room.id] || []).map(a => ({ ...a, p: this.frames.worldToLocal([a.world[0], a.world[1], 0]).slice(0, 2) }));
    return [...roomObjects(this.ws.v.elements, room), ...annotationObjects(ann)];
  }
  fixtureOut(room, f) {
    const l = this.frames.worldToLocal(f.position.ifcWorld), ph = f.photometricParameters;
    return { id: f.fixtureId, name: f.name, type: f.fixtureType, x_mm: toRoomMM(room, l)[0], y_mm: toRoomMM(room, l)[1], z_mm: Math.round((l[2] - room.floor) * 1000),
      flux_lm: ph.flux, power_w: ph.power, beam_deg: ph.beamAngle, cct_k: ph.cct, dimming_pct: ph.dimming,
      ...(f.fixtureType === 'spotlight' ? { tilt_deg: r1(f.rotation.aimTilt), azimuth_deg: r1(f.rotation.aimAzimuth) } : {}),
      ...(f.fixtureType === 'pendant' ? { suspension_mm: Math.round(ph.suspension * 1000) } : {}) };
  }

  /** agent parameters -> photometricParameters / rotation patches */
  params(type, a) {
    const t = FIXTURE_TYPES[type], ph = {}, rot = {};
    if (a.flux_lm != null) { ph.flux = a.flux_lm; if (a.power_w == null) ph.power = Math.round(a.flux_lm / (t.defaults.flux / t.defaults.power) * 10) / 10; }
    if (a.power_w != null) ph.power = a.power_w;
    const map = { beam_deg: 'beamAngle', cct_k: 'cct', dimming_pct: 'dimming', up_ratio: 'upRatio' };
    for (const [k, v] of Object.entries(map)) if (a[k] != null) ph[v] = a[k];
    if (a.suspension_mm != null) ph.suspension = a.suspension_mm / 1000;
    if (a.diameter_mm != null) ph.diameter = a.diameter_mm / 1000;
    if (a.length_mm != null) ph.length = a.length_mm / 1000;
    if (a.tilt_deg != null) rot.aimTilt = a.tilt_deg;
    if (a.azimuth_deg != null) rot.aimAzimuth = a.azimuth_deg;
    if (a.rotation_deg != null) rot.bodyRotation = a.rotation_deg;
    return { ph, rot };
  }
  /** Build validated fixtures at room-frame plan points; returns { fixtures, errors } */
  build(room, scheme, type, points, a, extra = () => ({})) {
    if (!FIXTURE_TYPES[type]) fail(`未知灯型 ${type}`);
    const fixtures = [], errors = [], { ph, rot } = this.params(type, a);
    if (type === 'spotlight' && rot.aimTilt === undefined) rot.aimTilt = 0;   // new spotlights point straight down unless aimed
    points.forEach((p, k) => {
      const pl = this.ws.planPlacement(p, FIXTURE_TYPES[type], room.floor);
      if (!pl.ok) { errors.push(`点 ${toRoomMM(room, p).join(',')}：${pl.reason}`); return; }
      if (pl.room.id !== room.id) { errors.push(`点 ${toRoomMM(room, p).join(',')} 落在「${pl.room.name}」而不是本房间`); return; }
      const e = extra(p, k) || {};
      const f = this.ws.buildFixture(type, pl, room, { photometry: { ...ph, ...(e.ph || {}) }, rotation: { ...rot, ...(e.rot || {}) },
        name: e.name, scheme: { fixtures: [...scheme.fixtures, ...fixtures] } });
      f.designState = 'ai-draft';
      const errs = P.validateFixture(f);
      if (errs.length) errors.push(`${f.name}：${errs.join('；')}`); else fixtures.push(f);
    });
    return { fixtures, errors };
  }
  commit(schemeId, label, fn) {
    this.ws.state.commit('AI: ' + label, d => fn(d.schemes[schemeId]));
    this.onEvent({ type: 'design', schemeId });
  }
  pts(room, list) { return list.map(q => fromRoomMM(room, q)); }
  aimPoint(room, target) {
    if (target.object_id) {
      const o = this.objectsIn(room).find(x => x.id === target.object_id) || fail(`对象 ${target.object_id} 不存在`);
      return [o.center[0], o.center[1], room.floor + Math.max(0.4, Math.min(1.6, (o.top ?? 1.2) * 0.75))];
    }
    const p = fromRoomMM(room, [target.x_mm, target.y_mm]); return [p[0], p[1], room.floor + (target.z_mm ?? 1200) / 1000];
  }

  /* ---------- tools ---------- */
  get_project_overview() {
    const v = this.ws.v, d = this.design;
    return {
      model: v.model.name, schema: v.model.schema, storeys: (v.model.levels || []).map(l => ({ name: l.name, elevation_m: l.elevation })),
      current_room: this.ws.room?.id || null,
      rooms: this.ws.rooms.map(r => ({ id: r.id, name: r.name, type: roomType(r.name), area_m2: +r.area.toFixed(2),
        size_mm: [Math.round((r.max[0] - r.min[0]) * 1000), Math.round((r.max[1] - r.min[1]) * 1000)], needs_confirmation: r.needsConfirmation,
        fixtures_in_active_scheme: this.ws.fixturesIn(r).length })),
      schemes: Object.entries(d.schemes).map(([id, s]) => ({ id, name: s.name, source: s.source || 'manual', fixtures: s.fixtures.length, editable: this.own.has(id) })),
      active_scheme: d.activeScheme,
    };
  }
  get_room_context({ room_id }) {
    const r = this.room(room_id), objects = this.objectsIn(r);
    return {
      room: { id: r.id, name: r.name, type: roomType(r.name), area_m2: +r.area.toFixed(2), size_mm: toRoomMM(r, r.max),
        footprint_mm: r.footprint.map(p => toRoomMM(r, p)), floor_level_m: r.floor,
        ceilings: r.ceilings.slice(0, 4).map(c => ({ height_mm: Math.round(c.height * 1000), coverage: +c.coverage.toFixed(2) })),
        mount_height_mm: r.ceiling != null ? Math.round((r.ceiling - r.floor) * 1000) : null, issues: r.issues },
      frame: '房间毫米坐标：原点为房间包围盒最小角，x 向 +IFC X，y 向 +IFC Y',
      walls: roomWalls(r.footprint).map(w => ({ wall_index: w.index, from_mm: toRoomMM(r, w.a), to_mm: toRoomMM(r, w.b), length_mm: Math.round(w.length * 1000), facing: w.side })),
      center_mm: toRoomMM(r, visualCenter(r.footprint, r.holes).point),
      objects: objects.map(o => ({ id: o.id, kind: o.kind, label: o.label, name: o.name, source: o.source, center_mm: toRoomMM(r, o.center),
        size_mm: o.size ? o.size.map(v => Math.round(v * 1000)) : null })),
      objects_note: objects.length ? null : '模型中未识别到家具 / 陈设，设计师也未在平面中标注；涉及家具位置的布置需说明假设',
      active_scheme_fixtures: this.ws.fixturesIn(r).map(f => this.fixtureOut(r, f)),
    };
  }
  get_design_targets({ room_id, styles = [] }) {
    const r = this.room(room_id), type = roomType(r.name);
    return { standard: { code: STANDARD.code, note: STANDARD.note, room: STANDARD.rooms[type], lpd: STANDARD.lpd }, targets: designTargets(type, styles) };
  }
  list_fixture_types() {
    return { note: '通用模拟灯具：cosᵐ 配光，无厂家 IES 数据', types: PLACEABLE.map(([k, t]) => ({ type: k, label: t.label, mount: t.mount, defaults: t.defaults,
      efficacy_lm_per_w: Math.round(t.defaults.flux / t.defaults.power) })), limits: P.LIMITS };
  }
  create_scheme({ name, room_id = null, room_ids = null, replace_existing = null, brief = '', styles = [], target_overrides = null }) {
    if (!room_id && !room_ids) fail('需要 room_id 或 room_ids');
    const rooms = room_ids ? this.roomsFor(room_ids) : [this.room(room_id)]; let id;
    const replace = replace_existing ?? rooms.length === 1, ids = new Set(rooms.map(r => r.id));
    const st = styles.length ? styles : parseStyles(brief);
    const targets = Object.fromEntries(rooms.map(r => [r.id, designTargets(roomType(r.name), st)]));
    for (const t of Object.values(targets)) if (target_overrides) {
      const o = target_overrides; if (!o.reason) fail('target_overrides 需要 reason');
      if (o.Eavg_min != null) t.Eavg[0] = o.Eavg_min; if (o.Eavg_max != null) t.Eavg[1] = o.Eavg_max;
      if ('U0_min' in o) t.U0 = o.U0_min;
      if (t.Eavg[0] < t.Emin_standard) fail(`Eavg_min 不能低于标准值 ${t.Emin_standard} lx`);
      t.overrides = o;
    }
    const base = this.design.activeScheme;
    this.ws.state.commit('AI: create scheme', d => {
      id = addScheme(d, { name, source: this.source, brief, newId: newFixtureId, copyFrom: base });
      if (replace) d.schemes[id].fixtures = d.schemes[id].fixtures.filter(f => !ids.has(f.roomId));   // building-level scheme: redesigned rooms start empty
      d.schemes[id].baseScheme = base; d.schemes[id].designedRooms = [...ids];
      d.schemes[id].targets = targets;
    });
    this.own.add(id); this.onEvent({ type: 'scheme', schemeId: id });
    const sc = this.design.schemes[id];
    return { scheme_id: id, rooms: rooms.map(r => ({ id: r.id, name: r.name })), ...(rooms.length === 1 ? { targets: targets[rooms[0].id] } : {}),
      kept_from_base: { scheme: base, fixtures: sc.fixtures.length, replaced_rooms: replace } };
  }
  place_in_rooms({ scheme_id, rooms, type, position = 'center', skip_rooms_with_fixtures = false, min_area_m2 = 1, ...a }) {
    const s = this.scheme(scheme_id, true), list = this.roomsFor(rooms), placed = [], skipped = [], errors = [];
    if (position !== 'center') fail('position 目前只支持 center');
    let batch = [];
    for (const r of list) {
      if (r.area < min_area_m2) { skipped.push({ room: r.name, reason: `面积 ${r.area.toFixed(1)} m² < ${min_area_m2}` }); continue; }
      if (isContainerSpace(this.ws.rooms, r)) { skipped.push({ room: r.name, reason: '整户空间（包含其他房间）' }); continue; }
      const existing = s.fixtures.filter(f => f.roomId === r.id).length;
      if (skip_rooms_with_fixtures && existing) { skipped.push({ room: r.name, reason: `已有 ${existing} 盏灯` }); continue; }
      // overlapping IfcSpaces: smaller rooms lying inside this one are treated as holes, so the centre stays in this room
      const inner = this.ws.rooms.filter(o => o !== r && o.area < r.area && o.footprint.some(q => r.contains(q[0], q[1], 0.05))).map(o => o.footprint);
      let p = snapPoints([visualCenter(r.footprint, [...(r.holes || []), ...inner]).point], 0.05, this.ws.plan.origin);
      if (inner.length && !r.contains(p[0][0], p[0][1])) p = snapPoints([visualCenter(r.footprint, r.holes).point], 0.05, this.ws.plan.origin);
      const res = this.build(r, { fixtures: [...s.fixtures, ...batch] }, type, p, a);
      if (res.fixtures.length) { batch.push(...res.fixtures); placed.push({ room_id: r.id, room: r.name, ...this.fixtureOut(r, res.fixtures[0]), existing_fixtures: existing }); }
      errors.push(...res.errors.map(e => `${r.name}：${e}`));
    }
    if (batch.length) this.commit(scheme_id, 'place in rooms', sc => sc.fixtures.push(...batch));
    this.design.schemes[scheme_id].designedRooms = [...new Set([...(s.designedRooms || []), ...placed.map(x => x.room_id)])];
    return { placed, skipped, errors, position: '房间视觉中心（离边界最远点），按 50 mm 模数取整' };
  }
  place_fixtures({ scheme_id, room_id, fixtures, snap_mm = 50 }) {
    const r = this.room(room_id), s = this.scheme(scheme_id, true);
    if (!Array.isArray(fixtures) || !fixtures.length) fail('fixtures 不能为空');
    const out = [], errors = [];
    for (const spec of fixtures) {
      const p = snapPoints(this.pts(r, [[spec.x_mm, spec.y_mm]]), snap_mm / 1000, this.ws.plan.origin)[0];
      const res = this.build(r, { fixtures: [...s.fixtures, ...out] }, spec.type, [p], spec, () => {
        const e = { name: spec.name };
        if (spec.aim_at) { const z = r.ceiling ?? r.floor + 2.5; e.rot = aimAt([p[0], p[1], z], this.aimPoint(r, spec.aim_at)); }
        return e;
      });
      out.push(...res.fixtures); errors.push(...res.errors);
    }
    if (out.length) this.commit(scheme_id, 'place', sc => sc.fixtures.push(...out));
    return { placed: out.map(f => this.fixtureOut(r, f)), errors };
  }
  layout_grid({ scheme_id, room_id, type, rows, cols, rule = 'half', margin_mm = 0, inset_mm = 0, area = null, snap_mm = 50, ...a }) {
    const r = this.room(room_id), s = this.scheme(scheme_id, true);
    if (!(rows >= 1 && cols >= 1 && rows * cols <= 64)) fail('rows×cols 应在 1–64 盏');
    const rect = area ? [...fromRoomMM(r, [area.x0_mm, area.y0_mm]), ...fromRoomMM(r, [area.x1_mm, area.y1_mm])] : null;
    const g = gridLayout(r, rows, cols, { rule, margin: margin_mm / 1000, inset: inset_mm / 1000, rect });
    const pts = snapPoints(g.points, snap_mm / 1000, this.ws.plan.origin);
    const res = this.build(r, s, type, pts, a);
    if (res.fixtures.length) this.commit(scheme_id, 'grid', sc => sc.fixtures.push(...res.fixtures));
    return { placed: res.fixtures.map(f => this.fixtureOut(r, f)), spacing_mm: g.spacing.map(v => v == null ? null : Math.round(v * 1000)),
      skipped_outside_room: g.outside.map(p => toRoomMM(r, p)), errors: res.errors };
  }
  layout_along_wall({ scheme_id, room_id, wall_index, type, count, offset_mm, rule = 'half', margin_mm = 0, end_clear_mm = 0, aim = 'down', snap_mm = 50, ...a }) {
    const r = this.room(room_id), s = this.scheme(scheme_id, true);
    const w = roomWalls(r.footprint)[wall_index] || fail(`墙 ${wall_index} 不存在（见 get_room_context.walls）`);
    if (!(count >= 1 && count <= 30)) fail('count 应为 1–30');
    let pts = alongWall(w, count, offset_mm / 1000, { rule, margin: margin_mm / 1000, endClear: end_clear_mm / 1000 });
    pts = snapPoints(pts, snap_mm / 1000, this.ws.plan.origin);
    const toward = Math.atan2(-w.inward[1], -w.inward[0]) * 180 / Math.PI;
    const res = this.build(r, s, type, pts, a, () => aim === 'down' ? {} : { rot: { aimTilt: a.tilt_deg ?? 30, aimAzimuth: aim === 'wall' ? toward : toward + 180 } });
    if (res.fixtures.length) this.commit(scheme_id, 'along wall', sc => sc.fixtures.push(...res.fixtures));
    return { placed: res.fixtures.map(f => this.fixtureOut(r, f)), wall: { length_mm: Math.round(w.length * 1000), facing: w.side }, errors: res.errors };
  }
  place_over_object({ scheme_id, room_id, type, target, ...a }) {
    const r = this.room(room_id), s = this.scheme(scheme_id, true);
    let p, note;
    if (target === 'room_center') { p = visualCenter(r.footprint, r.holes).point; note = '房间视觉中心（离边界最远点）'; }
    else { const o = this.objectsIn(r).find(x => x.id === target) || fail(`对象 ${target} 不存在`); p = o.center; note = `${o.label} 正上方`; }
    const res = this.build(r, s, type, snapPoints([p], 0.05, this.ws.plan.origin), a);
    if (res.fixtures.length) this.commit(scheme_id, 'over object', sc => sc.fixtures.push(...res.fixtures));
    return { placed: res.fixtures.map(f => this.fixtureOut(r, f)), position: note, errors: res.errors };
  }
  update_fixtures({ scheme_id, room_id, fixture_ids = [], filter_type = null, move_mm = null, ...a }) {
    const r = this.room(room_id), s = this.scheme(scheme_id, true);
    const ids = new Set(fixture_ids);
    const targets = s.fixtures.filter(f => (ids.size ? ids.has(f.fixtureId) : f.roomId === r.id) && (!filter_type || f.fixtureType === filter_type));
    if (!targets.length) fail('没有匹配的灯具');
    const errors = [], updated = [];
    const next = targets.map(f => {
      const c = JSON.parse(JSON.stringify(f)), { ph, rot } = this.params(f.fixtureType, a);
      Object.assign(c.photometricParameters, ph); Object.assign(c.rotation, rot);
      if (ph.suspension != null) { const w = [...c.position.ifcWorld]; w[2] += f.photometricParameters.suspension - ph.suspension; c.position.ifcWorld = w; }
      if (move_mm && (move_mm.dx || move_mm.dy)) {
        const l = this.frames.worldToLocal(c.position.ifcWorld), pl = this.ws.planPlacement([l[0] + (move_mm.dx || 0) / 1000, l[1] + (move_mm.dy || 0) / 1000], FIXTURE_TYPES[c.fixtureType], r.floor);
        if (!pl.ok) { errors.push(`${c.name}：${pl.reason}`); return null; }
        c.position.ifcWorld = this.frames.localToWorld([pl.local[0], pl.local[1], pl.local[2] - (mountDrop(c) ? mountDrop(c) - 0.005 : 0)]);
      }
      const errs = P.validateFixture(c); if (errs.length) { errors.push(`${c.name}：${errs.join('；')}`); return null; }
      this.ws.updateDerived(c); updated.push(c); return c;
    }).filter(Boolean);
    if (next.length) this.commit(scheme_id, 'update', sc => { for (const c of next) sc.fixtures[sc.fixtures.findIndex(f => f.fixtureId === c.fixtureId)] = c; });
    return { updated: updated.map(f => this.fixtureOut(r, f)), errors };
  }
  remove_fixtures({ scheme_id, fixture_ids }) {
    const s = this.scheme(scheme_id, true), ids = new Set(fixture_ids);
    const n = s.fixtures.filter(f => ids.has(f.fixtureId)).length; if (!n) fail('没有匹配的灯具');
    this.commit(scheme_id, 'remove', sc => { sc.fixtures = sc.fixtures.filter(f => !ids.has(f.fixtureId)); });
    return { removed: n };
  }
  /** Same calculation as the workspace's real-time estimate (photometry.js), for any scheme. */
  evaluate_scheme({ scheme_id, room_id = null }) {
    const s = this.scheme(scheme_id);
    if (!room_id) {
      const rooms = (s.designedRooms || []).map(id => this.ws.roomById(id)).filter(Boolean);
      if (!rooms.length) fail('本方案还没有设计任何房间');
      const out = rooms.map(r => { const e = this.evaluate_scheme({ scheme_id, room_id: r.id });
        return { room_id: r.id, room: r.name, Eavg: e.Eavg, U0: e.U0, lpd_w_m2: e.lpd_w_m2, fixtures: e.fixtures, pass: e.check.pass, failed: e.check.items.filter(i => !i.ok).map(i => i.name) }; });
      return { rooms: out, passed: out.filter(x => x.pass).length, total: out.length };
    }
    const r = this.room(room_id);
    const cs = this.design.calculationSettings, spacing = cs.gridSpacing === 'auto' ? P.autoSpacing(r.area) : cs.gridSpacing;
    const grid = P.workplaneGrid(r.footprint, r.holes, r.floor + cs.workplaneHeight, spacing, cs.border ?? 0.5);
    const fx = s.fixtures.filter(f => f.roomId === r.id);
    const em = fx.flatMap(f => P.fixtureEmitters(f, this.frames.worldToLocal(f.position.ifcWorld)));
    const values = grid.points.map(p => P.illuminanceAt(p, [0, 0, 1], em));
    const st = P.illuminanceStats(values);
    if (!st) fail('房间内没有有效采样点');
    const power = fx.reduce((a, f) => a + (f.photometricParameters.on ? f.photometricParameters.power * f.photometricParameters.dimming / 100 : 0), 0);
    const res = { Eavg: st.Eavg, Emin: st.Emin, Emax: st.Emax, U0: st.U0, lpd: power / r.area, power, cct: [...new Set(fx.map(f => f.photometricParameters.cct))].sort(), count: fx.length };
    const targets = s.targets?.[r.id] || designTargets(roomType(r.name), []);
    const check = checkTargets(targets, res);
    this.ws.state.design.schemes[scheme_id].results = { ...(s.results || {}), [r.id]: { ...res, pass: check.pass, at: new Date().toISOString() } };
    this.ws.state.dirty = true;
    return { method: '直接光逐点估算（未计遮挡与反射，Radiance 仿真可在定稿后运行）', samples: st.samples, workplane_m: cs.workplaneHeight,
      Eavg: Math.round(res.Eavg), Emin: Math.round(res.Emin), Emax: Math.round(res.Emax), U0: res.U0 == null ? null : +res.U0.toFixed(2),
      power_w: r1(power), lpd_w_m2: +res.lpd.toFixed(2), cct: res.cct, fixtures: fx.length, targets, check };
  }
  finalize_scheme({ scheme_id, room_id = null, title = null, rationale, assumptions = [] }) {
    this.scheme(scheme_id, true);
    if (!room_id) {                                       // multi-room scheme: per-room summary
      const ev = this.evaluate_scheme({ scheme_id });
      this.ws.state.commit('AI: finalize', d => { const sc = d.schemes[scheme_id]; if (title) sc.name = title; sc.rationale = rationale; sc.assumptions = assumptions; sc.finalizedAt = new Date().toISOString(); });
      const s = this.design.schemes[scheme_id];
      this.onEvent({ type: 'final', schemeId: scheme_id, roomId: null, scheme: s, rooms: ev.rooms });
      return { scheme_id, name: s.name, evaluation: { passed: ev.passed, total: ev.total } };
    }
    const r = this.room(room_id);
    const ev = this.evaluate_scheme({ scheme_id, room_id });
    this.ws.state.commit('AI: finalize', d => {
      const sc = d.schemes[scheme_id];
      if (title) sc.name = title;
      sc.rationale = rationale; sc.assumptions = assumptions; sc.finalizedAt = new Date().toISOString();
    });
    const s = this.design.schemes[scheme_id];
    this.onEvent({ type: 'final', schemeId: scheme_id, roomId: r.id, scheme: s, evaluation: ev });
    return { scheme_id, name: s.name, evaluation: { Eavg: ev.Eavg, U0: ev.U0, lpd_w_m2: ev.lpd_w_m2, pass: ev.check.pass } };
  }
}

export { OBJECT_KINDS, bbox };
