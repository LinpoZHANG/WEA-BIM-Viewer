/* WEA Lighting — design state: the lighting design document, undo/redo, selection.
 * The design is plain JSON (see storage.js for the schema); renderers and calculators only
 * read it. Every edit goes through commit() so it can be undone.
 */
export const SCHEMA_VERSION = 1;

export function emptyDesign(sourceModel) {
  const now = new Date().toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    app: 'WEA Lighting Design Studio',
    createdAt: now, updatedAt: now,
    sourceModel,                                   // { name, schema, projectGuid, fingerprint, origin, unit }
    calculationSettings: {
      workplaneHeight: 0.8,                        // m above finished floor
      border: 0.5,                                 // m band along the walls excluded from the calculation area (EN 12464-1 practice)
      gridSpacing: 'auto',                         // m, or 'auto' (0.25 m ≤ 40 m², else 0.5 m)
      surface: 'horizontal work plane, normal +Z',
      method: 'direct point-by-point E = Σ I(θ)·cosα / r²; generic cos^m distribution',
      occlusion: false, interreflection: false, maintenanceFactor: 1,
      scope: 'fixtures assigned to the room only',
    },
    designerSettings: { exposure: 0.03, ambient: 4, shadows: true, beams: true, bodies: true,
      heatmap: true, sampleValues: false, snap: true, snapStep: 0.05, legendMax: 'auto', isolateRoom: false, envelopeOnly: true },
    activeScheme: 'A',
    schemes: { A: { name: '方案 A', fixtures: [] }, B: { name: '方案 B', fixtures: [] } },
    roomOverrides: {},                             // roomGuid -> { floor, ceiling, footprint, confirmed }
    simulationSettings: null,                      // filled by the workspace (simulation.js defaults: Radiance + daylight)
  };
}

/* ---------- schemes: any number, keyed by short ids (A, B, C …) ----------
 * scheme { name, fixtures[], source: 'manual'|'ai'|'demo', brief?, rationale?, targets?, results?, createdAt? } */
export const SCHEME_SOURCES = { manual: '手动', ai: 'AI', demo: '离线演示' };
export function schemeIds(design) { return Object.keys(design.schemes); }
export function newSchemeId(design) {
  const used = new Set(schemeIds(design));
  for (let i = 0; ; i++) {
    const id = i < 26 ? String.fromCharCode(65 + i) : 'S' + (i + 1);
    if (!used.has(id)) return id;
  }
}
/** Add a scheme (mutates design); returns its id. copyFrom duplicates fixtures with new ids. */
export function addScheme(design, { name, source = 'manual', brief = null, copyFrom = null, newId } = {}) {
  const id = newSchemeId(design);
  const fixtures = copyFrom ? JSON.parse(JSON.stringify(design.schemes[copyFrom].fixtures)).map(f => ({ ...f, fixtureId: newId() })) : [];
  design.schemes[id] = { name: name || `方案 ${id}`, fixtures, source, brief, createdAt: new Date().toISOString() };
  return id;
}

export class LightingState extends EventTarget {
  constructor() {
    super();
    this.design = null; this.undoStack = []; this.redoStack = [];
    this.selectedId = null; this.dirty = false; this._last = null;
  }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  load(design) {
    this.design = design; this.undoStack = []; this.redoStack = []; this.selectedId = null; this.dirty = false;
    this.emit('change', { label: 'load' });
  }
  get scheme() { return this.design.schemes[this.design.activeScheme]; }
  get fixtures() { return this.scheme.fixtures; }
  fixture(id) { return this.fixtures.find(f => f.fixtureId === id) || null; }
  get selected() { return this.selectedId ? this.fixture(this.selectedId) : null; }
  /** Apply `mutate(design)` as one undoable step. Consecutive commits with the same `merge`
   *  key within 1.5 s (slider drags, gizmo moves) collapse into a single undo step. */
  commit(label, mutate, merge = null) {
    const now = Date.now();
    if (!(merge && this._last && this._last.key === merge && now - this._last.t < 1500)) {
      this.undoStack.push(JSON.stringify(this.design));
      if (this.undoStack.length > 200) this.undoStack.shift();
    }
    this._last = merge ? { key: merge, t: now } : null;
    this.redoStack = [];
    mutate(this.design);
    this.design.updatedAt = new Date().toISOString(); this.dirty = true;
    this.emit('change', { label });
  }
  _restore(from, to) {
    if (!from.length) return false;
    to.push(JSON.stringify(this.design));
    this.design = JSON.parse(from.pop()); this._last = null; this.dirty = true;
    if (this.selectedId && !this.fixture(this.selectedId)) this.selectedId = null;
    this.emit('change', { label: 'history' }); this.emit('select');
    return true;
  }
  undo() { return this._restore(this.undoStack, this.redoStack); }
  redo() { return this._restore(this.redoStack, this.undoStack); }
  select(id) { this.selectedId = id; this.emit('select'); }
}
