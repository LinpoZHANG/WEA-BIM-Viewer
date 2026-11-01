/* WEA AI — lighting criteria as data the designer agent looks up (never from model memory).
 * Normative values: GB 50034-2013《建筑照明设计标准》表 5.2.1 住宅建筑照明标准值 and 表 6.3.1
 * 住宅建筑每户照明功率密度限值. Check against the edition the project adopts (a revised GB 50034
 * may apply) — the table is plain data so it can be replaced without touching code.
 * Style targets are WEA design-practice defaults (editable), not normative.
 */
export const STANDARD = {
  code: 'GB 50034-2013', note: '表 5.2.1 / 6.3.1；项目如采用新版标准请替换本表',
  rooms: {
    living:   { label: '起居室', plane: '0.75 m 水平面', Eh: 100, task: { label: '书写、阅读', Eh: 300, mixed: true }, Ra: 80 },
    bedroom:  { label: '卧室', plane: '0.75 m 水平面', Eh: 75, task: { label: '床头、阅读', Eh: 150, mixed: true }, Ra: 80 },
    dining:   { label: '餐厅', plane: '0.75 m 餐桌面', Eh: 150, Ra: 80 },
    kitchen:  { label: '厨房', plane: '0.75 m 水平面', Eh: 100, task: { label: '操作台', Eh: 150, mixed: true }, Ra: 80 },
    bathroom: { label: '卫生间', plane: '0.75 m 水平面', Eh: 100, Ra: 80 },
    corridor: { label: '走道、楼梯间', plane: '地面', Eh: 50, Ra: 60 },
    study:    { label: '书房（按起居室阅读）', plane: '0.75 m 水平面', Eh: 100, task: { label: '书写、阅读', Eh: 300, mixed: true }, Ra: 80 },
    other:    { label: '其他居住空间', plane: '0.75 m 水平面', Eh: 100, Ra: 80 },
  },
  lpd: { current: 6.0, target: 5.0, unit: 'W/m²', scope: '每户照明功率密度（对应标准照度值）' },
};

const ROOM_WORDS = [
  ['living', ['起居', '客厅', '会客', 'living', 'lounge']], ['bedroom', ['卧', 'bed', '主人房', '次卧', '儿童房']],
  ['dining', ['餐', 'dining']], ['kitchen', ['厨', 'kitchen']], ['bathroom', ['卫', '浴', '洗手', 'bath', 'wc', 'toilet']],
  ['corridor', ['走道', '过道', '走廊', '门厅', '玄关', '楼梯', 'corridor', 'hall', 'lobby', 'stair']], ['study', ['书房', 'study', 'office']],
];
export function roomType(name) {
  const n = String(name || '').toLowerCase();
  return ROOM_WORDS.find(([, w]) => w.some(x => n.includes(x)))?.[0] || 'other';
}

/** Style words -> design targets (WEA practice defaults). Multiple styles combine (brightness max, CCT intersect). */
export const STYLES = {
  明亮: { EavgFactor: [2, 3], U0: 0.4, note: '整体亮度为标准值的 2–3 倍，均匀度较高' },
  温馨: { cct: [2700, 3000], layered: true, note: '暖色温，重点与洗墙光为主，避免全部均匀下照' },
  柔和: { EavgFactor: [1, 1.5], U0: 0.4, glare: 'low', note: '宽光束、低眩光，可调光' },
  氛围: { EavgFactor: [0.6, 1.2], cct: [2700, 3000], layered: true, contrast: 'high', note: '对比更强，基础光弱、重点光突出' },
  现代: { cct: [3000, 4000], note: '中性偏暖，线条整齐、对齐布置' },
  简约: { note: '灯具数量少、对齐、隐藏光源' },
  清爽: { cct: [3500, 4000], EavgFactor: [1.5, 2.5], note: '中性色温' },
  高级: { layered: true, contrast: 'medium', note: '层次分明，重点照明突出材质与陈设' },
};
export function parseStyles(text) { return Object.keys(STYLES).filter(k => String(text).includes(k)); }

/** Quantified targets for a room type + style words. */
export function designTargets(type, styles = []) {
  const s = STANDARD.rooms[type] || STANDARD.rooms.other;
  let f = [1, 1.5], cct = [2700, 4000], U0 = 0.4, layered = false;
  const notes = [];
  for (const k of styles) {
    const st = STYLES[k]; if (!st) continue;
    if (st.EavgFactor) f = [Math.max(f[0], st.EavgFactor[0]), Math.max(f[1], st.EavgFactor[1])];
    if (st.cct) cct = [Math.max(cct[0], st.cct[0]), Math.min(cct[1], st.cct[1])];
    if (st.U0) U0 = Math.max(U0, st.U0);
    layered ||= !!st.layered; notes.push(`${k}：${st.note}`);
  }
  if (cct[0] > cct[1]) cct = [cct[1], cct[1]];
  return {
    roomType: type, standard: `${STANDARD.code} ${s.label} ${s.plane} ${s.Eh} lx`,
    Eavg: [Math.round(s.Eh * f[0]), Math.round(s.Eh * f[1])], Emin_standard: s.Eh, U0, cct, Ra: Math.max(s.Ra, styles.includes('高级') ? 90 : 80),
    lpdMax: STANDARD.lpd.current, layered, notes,
    caveat: '照度区间与色温为 WEA 设计经验值（标准值为下限）；功率密度限值对应标准照度，提高照度时仅作参考',
  };
}

/** Pass / fail of computed results against targets. */
export function checkTargets(t, r) {
  const items = [];
  const add = (name, ok, value, want) => items.push({ name, ok, value, want });
  add('平均照度 Eavg', r.Eavg >= t.Eavg[0] && r.Eavg <= t.Eavg[1] * 1.15, Math.round(r.Eavg), `${t.Eavg[0]}–${t.Eavg[1]} lx`);
  add('标准下限', r.Eavg >= t.Emin_standard, Math.round(r.Eavg), `≥ ${t.Emin_standard} lx`);
  if (r.U0 != null && t.U0 != null) add('均匀度 U0', r.U0 >= t.U0 - 1e-9, +r.U0.toFixed(2), `≥ ${t.U0}`);
  if (r.cct?.length) add('色温', r.cct.every(c => c >= t.cct[0] && c <= t.cct[1]), r.cct.join('/'), `${t.cct[0]}–${t.cct[1]} K`);
  if (r.lpd != null) add('功率密度', r.lpd <= t.lpdMax * Math.max(1, t.Eavg[0] / t.Emin_standard), +r.lpd.toFixed(2), `≤ ${t.lpdMax} W/m²（照度高于标准值时按比例调整）`);
  return { pass: items.every(i => i.ok), items };
}
