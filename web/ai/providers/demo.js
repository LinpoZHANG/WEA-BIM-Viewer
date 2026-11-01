/* WEA AI — offline demo provider: a fixed, rule-based design script that drives the SAME tools as a
 * real LLM (so the whole pipeline — tools, drafts, evaluation loop, scheme cards, viewer, drawings —
 * can be demonstrated and tested without an API). It is not an AI: it understands fixture counts,
 * fixture types, style words and room names, and always produces the same three design strategies.
 */
import { parseStyles } from '../standards.js';

const NUM = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const TYPE_WORDS = [['spotlight', ['射灯']], ['downlight', ['筒灯']], ['pendant', ['吊灯']], ['linear', ['线性灯', '灯带', '线条灯']], ['ceiling', ['吸顶灯']]];
const ROOM_WORDS = [['living', ['客厅', '起居']], ['bedroom', ['卧室']], ['dining', ['餐厅']], ['kitchen', ['厨房']], ['study', ['书房']], ['bathroom', ['卫生间']]];
const MAX_FLUX = { spotlight: 1500, downlight: 2000, pendant: 5000, linear: 2400 };
const MAX_BEAM = { spotlight: 60, downlight: 90, linear: 120 };                 // practical beam limits per fixture type

function cnNumber(s) {
  if (/^\d+$/.test(s)) return +s;
  if (s === '十') return 10;
  if (s.startsWith('十')) return 10 + (NUM[s[1]] || 0);
  if (s.endsWith('十')) return (NUM[s[0]] || 1) * 10;
  if (s.includes('十')) return (NUM[s[0]] || 1) * 10 + (NUM[s.at(-1)] || 0);
  return NUM[s] || null;
}
export function parseRequest(text) {
  const counts = {};
  const re = /(\d+|[一二两三四五六七八九十]+)\s*(?:个|盏|只|套|组|条)?\s*(?:[一-龥]{0,4}?)(射灯|筒灯|吊灯|线性灯|灯带|线条灯|吸顶灯)/g;
  for (const m of text.matchAll(re)) {
    const n = cnNumber(m[1]), type = TYPE_WORDS.find(([, w]) => w.includes(m[2]))[0];
    if (n) counts[type] = (counts[type] || 0) + n;
  }
  for (const [type, words] of TYPE_WORDS) if (!counts[type] && words.some(w => text.includes('一' + w) || text.includes('个' + w))) counts[type] = counts[type] || 0;
  const roomType = ROOM_WORDS.find(([, w]) => w.some(x => text.includes(x)))?.[0] || null;
  // batch: "每个 / 所有 / 全部 / 各个房间 … 中心 …"
  const batch = /(每个|每一个|每间|所有|全部|各个?)\s*(房间|空间|屋子?)/.test(text);
  const center = /(中心|中央|正中|中间)/.test(text);
  const perRoom = batch ? (cnNumber((text.match(/(\d+|[一二两三四五六七八九十]+)\s*(?:个|盏|只|套)?\s*[\u4e00-\u9fa5]{0,3}灯/) || [])[1] || '一') || 1) : null;
  return { counts, styles: parseStyles(text), roomType, batch, center, perRoom };
}

/** rows × cols with rows·cols = n, cells closest to square for a w × h rectangle */
function bestGrid(n, w, h) {
  let best = [1, n], score = Infinity;
  for (let r = 1; r <= n; r++) if (n % r === 0) {
    const c = n / r, s = Math.abs(Math.log((w / c) / (h / r)));
    if (s < score) { score = s; best = [r, c]; }
  }
  return best;
}

/** what a designer would suggest when the requested fixtures cannot reach the targets */
function advice(failed, type, n) {
  const tips = [];
  if (failed.some(f => f.startsWith('均匀度'))) tips.push(type === 'spotlight' ? `${n} 盏射灯（光束角上限约 60°）难以让工作面均匀，可改用宽光束筒灯（90°）或增加灯具数量` : '可增加灯具数量或加宽光束');
  if (failed.some(f => f.startsWith('平均照度') || f.startsWith('标准下限'))) tips.push('照度不足：可增加灯具或提高单灯光通量（需选更大功率型号）');
  return tips.length ? '建议：' + tips.join('；') + '。' : '';
}

function* designScript(text) {
  const req = parseRequest(text);
  if (req.batch) return yield* batchScript(text, req);
  if (!Object.keys(req.counts).length && !req.styles.length && !req.roomType)
    return { content: '离线演示只能根据“房间 + 风格词 + 灯具数量”生成新方案（例如：我要一个明亮温馨风格的客厅，架设八个射灯和一个装饰吊灯）。修改已有方案、自由对话需要接入大模型；也可以在视图中手动调整。' };
  const call = (name, args) => ({ tool_calls: [{ id: 'demo-' + Math.random().toString(36).slice(2, 9), name, arguments: args }] });
  const [ov] = yield call('get_project_overview', {});
  let room = ov.rooms.find(r => r.id === ov.current_room);
  if (req.roomType && room?.type !== req.roomType) room = ov.rooms.filter(r => r.type === req.roomType).sort((a, b) => b.area_m2 - a.area_m2)[0] || room;
  if (!room) return { content: '没有找到可设计的房间，请先在左侧选择房间。' };
  const [ctx] = yield call('get_room_context', { room_id: room.id });
  const [tg] = yield call('get_design_targets', { room_id: room.id, styles: req.styles });
  const T = tg.targets, cct = T.cct[0] >= 3000 ? T.cct[0] : (req.styles.includes('明亮') ? 3000 : T.cct[0]);
  const [W, H] = ctx.room.size_mm;
  const counts = Object.keys(req.counts).length ? req.counts : { downlight: Math.max(4, Math.round(room.area_m2 / 3.5)) };
  const mainType = ['spotlight', 'downlight', 'linear'].find(t => counts[t]) || null;
  const nMain = mainType ? (counts[mainType] || 0) : 0, nPendant = counts.pendant ?? 0;
  const walls = [...ctx.walls].sort((a, b) => b.length_mm - a.length_mm);
  const opposite = w => walls.find(x => x !== w && ((w.facing === 'N' && x.facing === 'S') || (w.facing === 'S' && x.facing === 'N') || (w.facing === 'E' && x.facing === 'W') || (w.facing === 'W' && x.facing === 'E')));
  const anchor = ctx.objects.find(o => ['coffee_table', 'dining_table', 'sofa'].includes(o.kind));
  const assumptions = ['通用模拟灯具（cosᵐ 配光，非厂家 IES）', '照度为直接光估算，未计遮挡与反射'];
  if (nPendant) assumptions.push(anchor ? `吊灯位于${anchor.label}上方（${anchor.source === 'annotation' ? '设计师标注' : 'IFC 构件'}）` : '模型中没有家具 / 标注，吊灯暂定在房间视觉中心；可在平面定位中用“标注”标出茶几后重新生成');
  const lum = { spotlight: 700, downlight: 800, linear: 900 }[mainType] || 700;
  const base = { cct_k: cct, flux_lm: lum };

  const variants = [
    { name: '均匀基础光', idea: `${nMain} 盏${mainType === 'spotlight' ? '射灯' : '灯'}按行列均分（端距 = 间距 / 2），宽光束垂直下照提供均匀基础光`,
      build: function* (sid) {
        if (nMain) { const [r, c] = bestGrid(nMain, W, H); yield call('layout_grid', { scheme_id: sid, room_id: room.id, type: mainType, rows: r, cols: c, rule: 'half', beam_deg: MAX_BEAM[mainType], ...base }); }
      } },
    { name: '洗墙温馨', layered: true, idea: `${nMain} 盏${mainType === 'spotlight' ? '射灯' : '灯'}离墙 600 mm 沿两面长墙布置、斜照墙面，墙面亮、空间柔和，${nPendant ? '吊灯作为视觉焦点' : '中部较暗以营造层次'}`,
      build: function* (sid) {
        if (!nMain) return;
        const w1 = walls[0], w2 = opposite(w1) || walls[1], a = Math.ceil(nMain / 2), b = nMain - a;
        yield call('layout_along_wall', { scheme_id: sid, room_id: room.id, wall_index: w1.wall_index, type: mainType, count: a, offset_mm: 600, rule: 'half', aim: mainType === 'spotlight' ? 'wall' : 'down', tilt_deg: 25, beam_deg: 40, ...base });
        if (b) yield call('layout_along_wall', { scheme_id: sid, room_id: room.id, wall_index: w2.wall_index, type: mainType, count: b, offset_mm: 600, rule: 'half', aim: mainType === 'spotlight' ? 'wall' : 'down', tilt_deg: 25, beam_deg: 40, ...base });
      } },
    { name: '重点 + 氛围', layered: true, idea: `一半${mainType === 'spotlight' ? '射灯' : '灯具'}在中部提供基础光，另一半沿主墙（电视墙 / 背景墙）做重点照明，基础光调暗以加强对比`,
      build: function* (sid) {
        if (!nMain) return;
        const a = Math.ceil(nMain / 2), b = nMain - a, [r, c] = bestGrid(a, W * 0.6, H * 0.6);
        yield call('layout_grid', { scheme_id: sid, room_id: room.id, type: mainType, rows: r, cols: c, rule: 'half', inset_mm: Math.round(Math.min(W, H) * 0.2), beam_deg: 50, ...base, dimming_pct: 80 });
        if (b) yield call('layout_along_wall', { scheme_id: sid, room_id: room.id, wall_index: walls[0].wall_index, type: mainType, count: b, offset_mm: 500, rule: 'half', aim: mainType === 'spotlight' ? 'wall' : 'down', tilt_deg: 30, beam_deg: 24, ...base });
      } },
  ];
  const finals = [];
  for (const v of variants) {
    const [cs] = yield call('create_scheme', { name: `AI · ${v.name}`, room_id: room.id, brief: text, styles: req.styles,
      ...(v.layered ? { target_overrides: { U0_min: null, reason: '分层照明：以墙面与重点照明为主，工作面均匀度不作为目标（GB 50034 住宅未规定 U0）' } } : {}) });
    const sid = cs.scheme_id;
    let errors = [];
    for (const c of v.build(sid)) { const [res] = yield c; errors.push(...(res.errors || []), ...(res.ok ? [] : [res.error])); }
    if (nPendant) for (let k = 0; k < nPendant; k++) {
      const [res] = yield call('place_over_object', { scheme_id: sid, room_id: room.id, type: 'pendant', target: anchor ? anchor.id : 'room_center', cct_k: Math.min(cct, 2700), flux_lm: 1500, suspension_mm: Math.max(400, Math.min(900, (ctx.room.mount_height_mm || 2600) - 2000)) });
      errors.push(...(res.errors || []), ...(res.ok ? [] : [res.error]));
    }
    // calculation – correction loop
    let [ev] = yield call('evaluate_scheme', { scheme_id: sid, room_id: room.id }), iter = 0, beamMaxed = !v.layered;
    const log = [];
    while (!ev.check?.pass && iter < 5 && ev.fixtures) {
      iter++;
      const lo = T.Eavg[0], hi = T.Eavg[1], mid = (lo + hi) / 2, u0 = ev.check.items.find(i => i.name.startsWith('均匀度'));
      if (ev.Eavg < lo || ev.Eavg > hi * 1.15) {
        const k = mid / Math.max(ev.Eavg, 1);
        const flux = Math.round(Math.min(MAX_FLUX[mainType] || 1500, lum * k * (iter > 1 ? 1.1 : 1)) / 10) * 10;
        if (mainType) { const [u] = yield call('update_fixtures', { scheme_id: sid, room_id: room.id, filter_type: mainType, flux_lm: flux }); if (u.ok) log.push(`主灯光通量调至 ${flux} lm`); }
        if (flux >= (MAX_FLUX[mainType] || 1500) && nPendant) { yield call('update_fixtures', { scheme_id: sid, room_id: room.id, filter_type: 'pendant', flux_lm: 3000 }); log.push('吊灯提高至 3000 lm'); }
      } else if (u0 && !u0.ok && mainType && !beamMaxed) {
        const [u] = yield call('update_fixtures', { scheme_id: sid, room_id: room.id, filter_type: mainType, beam_deg: MAX_BEAM[mainType] });
        beamMaxed = true; if (u.ok) log.push(`光束角放宽到 ${MAX_BEAM[mainType]}° 以改善均匀度`);
      } else break;
      [ev] = yield call('evaluate_scheme', { scheme_id: sid, room_id: room.id });
    }
    const failed = ev.check?.items.filter(i => !i.ok).map(i => `${i.name} ${i.value}（目标 ${i.want}）`) || [];
    const rationale = `${v.idea}${nPendant ? `；装饰吊灯 ${nPendant} 盏` : ''}。色温 ${cct} K${nPendant ? `（吊灯 ${Math.min(cct, 2700)} K）` : ''}。`
      + `计算：Eavg ${ev.Eavg} lx、U0 ${ev.U0 ?? '—'}、功率密度 ${ev.lpd_w_m2} W/m²。${log.length ? '调整：' + log.join('；') + '。' : ''}`
      + (failed.length ? `未达标：${failed.join('；')}（已在单灯参数上限内尽量调整）。${advice(failed, mainType, nMain)}` : '各项目标均达标。')
      + (v.layered ? ' 本方案为分层照明，不考核工作面均匀度。' : '')
      + (errors.length ? ` 布置提示：${errors.slice(0, 3).join('；')}` : '');
    yield call('finalize_scheme', { scheme_id: sid, room_id: room.id, rationale, assumptions });
    finals.push({ name: v.name, ev, failed });
  }
  const lines = finals.map((f, i) => `${i + 1}. **${f.name}**：Eavg ${f.ev.Eavg} lx · U0 ${f.ev.U0 ?? '—'} · ${f.ev.lpd_w_m2} W/m² ${f.failed.length ? '（部分未达标）' : '✓ 达标'}`);
  return { content: `已为「${room.name}」生成 ${finals.length} 个方案（离线演示脚本，非大模型）。\n目标：${T.Eavg[0]}–${T.Eavg[1]} lx，U0 ≥ ${T.U0}（分层方案不考核），${T.cct[0]}–${T.cct[1]} K（${T.standard} 为下限）。\n${lines.join('\n')}\n结果为直接光估算；可点方案卡片在视图中打开、继续修改或出图。` };
}

/** "每个房间中心架设一个灯": one fixture at the visual centre of every room, then a per-room check */
function* batchScript(text, req) {
  const call = (name, args) => ({ tool_calls: [{ id: 'demo-' + Math.random().toString(36).slice(2, 9), name, arguments: args }] });
  if (!req.center) return { content: '离线演示的批量布置目前只支持“每个房间中心放一盏灯”（例如：每个房间中心架设一个吸顶灯）。其他批量规则需要接入大模型。' };
  if (req.perRoom !== 1) return { content: `离线演示的批量布置目前每个房间只放 1 盏（你要求 ${req.perRoom} 盏）；多盏需按房间形状排布，请逐个房间描述或接入大模型。` };
  const type = Object.keys(req.counts)[0] || 'ceiling';
  const label = { ceiling: '吸顶灯', downlight: '筒灯', spotlight: '射灯', pendant: '吊灯', linear: '线性灯' }[type];
  yield call('get_project_overview', {});
  const [cs] = yield call('create_scheme', { name: `AI · 各房间中心${label}`, room_ids: ['all'], replace_existing: false, brief: text, styles: req.styles });
  if (!cs.ok) return { content: '新建方案失败：' + cs.error };
  const sid = cs.scheme_id;
  const [pr] = yield call('place_in_rooms', { scheme_id: sid, rooms: ['all'], type, position: 'center' });
  const [ev] = yield call('evaluate_scheme', { scheme_id: sid });
  const low = ev.rooms.filter(r => !r.pass), withExisting = pr.placed.filter(p => p.existing_fixtures);
  const rationale = `在 ${pr.placed.length} 个房间的视觉中心（离边界最远点，按 50 mm 模数取整）各布置 1 盏${label}。`
    + `${pr.skipped.length ? `跳过 ${pr.skipped.length} 个：${pr.skipped.map(s => `${s.room}（${s.reason}）`).join('、')}。` : ''}`
    + `${pr.errors.length ? `未能放置：${pr.errors.join('；')}。` : ''}`
    + `${withExisting.length ? `${withExisting.map(p => p.room).join('、')} 原有灯具已保留，中心灯为新增。` : ''}`
    + `计算：${ev.passed}/${ev.total} 个房间达到 GB 50034 标准值${low.length ? `；未达标：${low.map(r => `${r.room} ${r.Eavg} lx`).join('、')}（单灯不足以照亮较大房间，建议增加灯具）` : ''}。`;
  yield call('finalize_scheme', { scheme_id: sid, rationale, assumptions: ['位置为房间几何中心，未考虑家具与吊顶造型', '通用模拟灯具，照度为直接光估算'] });
  return { content: `已新建方案「AI · 各房间中心${label}」（离线演示脚本，非大模型）：${pr.placed.length} 个房间各 1 盏${label}${pr.skipped.length ? `，跳过 ${pr.skipped.length} 个` : ''}。\n照度：${ev.passed}/${ev.total} 个房间达到标准值${low.length ? `，${low.length} 个偏暗（${low.slice(0, 5).map(r => r.room).join('、')}${low.length > 5 ? '…' : ''}）` : ''}。\n点卡片「全局查看」可看到整栋所有房间的灯和热力图。` };
}

export function demoProvider() {
  let gen = null, lastUser = -1;
  return {
    id: 'demo', label: '离线演示（规则脚本）',
    async next({ messages }) {
      const iu = messages.findLastIndex(m => m.role === 'user');
      let input;
      if (iu !== lastUser) { lastUser = iu; gen = designScript(messages[iu].content.replace(/\n（当前房间：[^\n]*）$/, '')); input = undefined; }
      else {
        const ia = messages.findLastIndex(m => m.role === 'assistant');
        input = messages.slice(ia + 1).filter(m => m.role === 'tool').map(m => JSON.parse(m.content));
      }
      await new Promise(r => setTimeout(r, 15));
      const { value, done } = gen.next(input);
      if (done) { gen = null; return { content: value?.content || '完成。' }; }
      return value;
    },
  };
}
