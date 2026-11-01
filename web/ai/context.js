/* WEA AI — what is in a room, for the designer agent.
 * Two sources, both reported with their origin so the agent never invents positions:
 *   ifc         architectural elements inside the room recognised by name (sofa, table, artwork …);
 *               generic keyword matching over element names, for any IFC (nothing model-specific)
 *   annotation  points the designer marked in the plan view (design data, never written to the IFC)
 */
import { inPolygon } from '../lighting/photometry.js';

export const OBJECT_KINDS = {
  sofa: { label: '沙发', words: ['沙发', 'sofa', 'couch'] },
  coffee_table: { label: '茶几', words: ['茶几', 'coffee table', 'coffeetable'] },
  tv: { label: '电视 / 电视墙', words: ['电视', 'tv', 'television', '影音'] },
  artwork: { label: '挂画 / 艺术品', words: ['挂画', '装饰画', '画框', 'painting', 'artwork', 'picture', '艺术'] },
  dining_table: { label: '餐桌', words: ['餐桌', 'dining table', 'diningtable'] },
  bed: { label: '床', words: ['床', 'bed'] },
  desk: { label: '书桌', words: ['书桌', '写字台', 'desk'] },
  island: { label: '岛台', words: ['岛台', 'island'] },
  counter: { label: '操作台', words: ['操作台', '台面', 'countertop', 'worktop'] },
  cabinet: { label: '柜体', words: ['柜', 'cabinet', 'wardrobe', 'shelf', '书架'] },
  plant: { label: '绿植', words: ['植物', '绿植', 'plant'] },
  chair: { label: '座椅', words: ['椅', 'chair', 'armchair', 'stool'] },
  rug: { label: '地毯', words: ['地毯', 'rug', 'carpet'] },
  other: { label: '其他', words: [] },
};

export function classifyObject(name) {
  const n = String(name || '').toLowerCase();
  for (const [k, v] of Object.entries(OBJECT_KINDS)) if (v.words.some(w => n.includes(w))) return k;
  return null;
}

/** elements: viewer elements (bbox in view coords [x0,y0,z0,x1,y1,z1], y = IFC z, z = −IFC y). */
export function roomObjects(elements, room) {
  const out = [];
  elements.forEach((e, i) => {
    if (!e.bbox || e.category === 7 || e.discipline === 'MEP') return;
    const kind = classifyObject(e.name) || classifyObject(e.type); if (!kind) return;
    const b = e.bbox, cx = (b[0] + b[3]) / 2, cy = -(b[2] + b[5]) / 2;
    if (b[1] > room.floor + 2.2 || b[4] < room.floor - 0.05 || !inPolygon(cx, cy, room.footprint, room.holes || [])) return;
    out.push({ id: 'el:' + e.guid, kind, label: OBJECT_KINDS[kind].label, name: e.name, source: 'ifc',
      center: [cx, cy], size: [b[3] - b[0], b[5] - b[2]], top: b[4] - room.floor });
  });
  return out;
}

export function annotationObjects(annotations = []) {
  return annotations.map(a => ({ id: 'an:' + a.id, kind: a.kind, label: a.label || OBJECT_KINDS[a.kind]?.label || a.kind, name: a.label, source: 'annotation',
    center: a.p, size: a.size || null, top: a.top ?? null }));
}
