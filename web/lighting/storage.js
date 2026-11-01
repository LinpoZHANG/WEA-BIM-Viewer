/* WEA Lighting — persistence of lighting designs (never written into the IFC).
 * Server: GET/POST /api/lighting?model=<name>  ->  designs/<name>.lighting.json (see server.py)
 * Files : export / import the same JSON.
 *
 * Schema (schemaVersion 1):
 *   sourceModel { name, schema, projectGuid, fingerprint, origin[3], unit:'m' }
 *   calculationSettings, designerSettings, activeScheme, schemes { A|B: { name, fixtures[] } },
 *   roomOverrides { <IfcSpace GlobalId>: { floor, ceiling, footprint, confirmed } }
 *   fixture { fixtureId, name, fixtureType, catalogCode, roomId (IfcSpace GlobalId), roomExpressId,
 *             ifcProjectId, position { ifcWorld[3] m, roomLocal[3] m }, mountHeight m,
 *             rotation { aimTilt°, aimAzimuth°, bodyRotation° }, mountReference { kind, surface,
 *             elementGuid, elementId, elementName, normal[3] (IFC), status, message },
 *             photometricParameters { flux lm, power W, beamAngle °, cct K, dimming %, on, length m,
 *             distribution, photometrySource:'generic', ies }, notes, designState }
 */
import { SCHEMA_VERSION } from './state.js';
import { validateFixture } from './photometry.js';

/** Stable fingerprint of the source model: name, schema, entity count and sorted IfcSpace GlobalIds (FNV-1a). */
export function modelFingerprint(model) {
  const rooms = model.elements.filter(e => e.room).map(e => e.guid).sort().join(',');
  const text = [model.name, model.schema, model.stats?.entities, model.project?.guid, rooms].join('|');
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return 'fnv1a:' + h.toString(16).padStart(8, '0');
}

export async function loadFromServer(modelName) {
  const r = await fetch('/api/lighting?model=' + encodeURIComponent(modelName), { cache: 'no-store' });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('读取照明方案失败（' + r.status + '）');
  return r.json();
}

/** Most recent design of the same IFC project saved under another model name (re-export / renamed file), or null. */
export async function findForProject(projectGuid, exceptModel) {
  if (!projectGuid) return null;
  const r = await fetch('/api/lighting/find?project=' + encodeURIComponent(projectGuid), { cache: 'no-store' });
  if (!r.ok) return null;
  const hit = (await r.json()).designs.find(d => d.model !== exceptModel);
  return hit ? { model: hit.model, design: await loadFromServer(hit.model) } : null;
}

export async function saveToServer(modelName, design) {
  const r = await fetch('/api/lighting?model=' + encodeURIComponent(modelName), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(design, null, 1) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || '保存失败（' + r.status + '）');
  return data;
}

export function exportFile(design) {
  const name = (design.sourceModel?.name || 'model') + '.lighting.json';
  const url = URL.createObjectURL(new Blob([JSON.stringify(design, null, 1)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export async function readFile(file) {
  const design = JSON.parse(await file.text());
  if (design.schemaVersion !== SCHEMA_VERSION) throw new Error(`不支持的方案版本 ${design.schemaVersion}`);
  if (!design.schemes) throw new Error('文件不是 WEA 照明方案');
  return design;
}

/**
 * Check a loaded design against the current model. Never moves fixtures: unresolved references
 * are marked on the fixture (mountReference.status = 'invalid') and returned as a report.
 */
export function verifyDesign(design, model, ctx) {
  const report = [];
  const fp = modelFingerprint(model);
  if (design.sourceModel?.fingerprint && design.sourceModel.fingerprint !== fp)
    report.push({ level: 'warn', message: `方案来自另一版本模型（${design.sourceModel.name}，指纹 ${design.sourceModel.fingerprint}），已逐一校验关联` });
  const byGuid = new Map(model.elements.map((e, i) => [e.guid, i]));
  for (const [key, scheme] of Object.entries(design.schemes)) {
    for (const f of scheme.fixtures) {
      const errs = validateFixture(f);
      if (errs.length) report.push({ level: 'error', fixtureId: f.fixtureId, message: `${f.name}（${key}）参数无效：${errs.join('；')}` });
      if (f.roomId && !byGuid.has(f.roomId)) report.push({ level: 'error', fixtureId: f.fixtureId, message: `${f.name}（${key}）所属房间 ${f.roomId} 在当前模型中不存在` });
      const mr = f.mountReference || {};
      if (mr.kind === 'surface') {
        const res = ctx.checkMount(f);
        mr.status = res.ok ? 'ok' : 'invalid'; mr.message = res.message;
        if (!res.ok) report.push({ level: 'error', fixtureId: f.fixtureId, message: `${f.name}（${key}）：${res.message}` });
      }
    }
  }
  return report;
}
