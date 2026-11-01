/* WEA Lighting — fixture catalogue (first version: generic simulated fixtures only).
 * None of these entries carries manufacturer photometry; every fixture created from them is
 * marked photometrySource: 'generic' and uses the cosine-power distribution of photometry.js.
 * `ies` is reserved for a future IES/LDT file reference (not parsed in this version).
 */
import { DISTRIBUTION_MODEL } from './photometry.js';

export const FIXTURE_TYPES = {
  downlight: {
    label: '嵌入式筒灯', code: 'GEN-DL', mount: ['ceiling'], icon: '◎',
    defaults: { flux: 600, power: 7, beamAngle: 60, cct: 3000, dimming: 100, on: true },
    rotation: { aimTilt: 0, aimAzimuth: 0, bodyRotation: 0 }, size: { diameter: 0.09, depth: 0.06 },
  },
  spotlight: {
    label: '可调角度射灯', code: 'GEN-SP', mount: ['ceiling', 'wall'], icon: '◉',
    defaults: { flux: 450, power: 6, beamAngle: 24, cct: 3000, dimming: 100, on: true },
    rotation: { aimTilt: 30, aimAzimuth: 0, bodyRotation: 0 }, size: { diameter: 0.07, depth: 0.12 },
  },
  linear: {
    label: '线性灯具', code: 'GEN-LN', mount: ['ceiling'], icon: '▭',
    defaults: { flux: 900, power: 12, beamAngle: 120, cct: 3000, dimming: 100, on: true, length: 1.2 },
    rotation: { aimTilt: 0, aimAzimuth: 0, bodyRotation: 0 }, size: { width: 0.04, depth: 0.04 },
  },
  // surface-mounted ceiling light (吸顶灯): wide diffuse distribution, the usual single central room light
  ceiling: {
    label: '吸顶灯', code: 'GEN-CL', mount: ['ceiling'], icon: '◯',
    defaults: { flux: 1800, power: 20, beamAngle: 120, cct: 3000, dimming: 100, on: true, diameter: 0.4 },
    rotation: { aimTilt: 0, aimAzimuth: 0, bodyRotation: 0 }, size: { diameter: 0.4, depth: 0.08 },
  },
  // luminous surface: an existing BIM element assigned as emitter (not placed from the catalogue)
  luminous: {
    label: '发光体', code: 'LUM', mount: [], icon: '✧', assignOnly: true,
    defaults: { flux: 1000, power: 16, beamAngle: 120, cct: 3000, dimming: 100, on: true, luminance: 300 },
    rotation: { aimTilt: 0, aimAzimuth: 0, bodyRotation: 0 }, size: {},
  },
  // decorative pendant: hangs `suspension` m below the ceiling (position = luminous centre);
  // `upRatio` of the flux goes up (Lambertian, lights the ceiling), the rest down with the beam angle
  pendant: {
    label: '装饰吊灯', code: 'GEN-PD', mount: ['ceiling'], icon: '◇',
    defaults: { flux: 1500, power: 18, beamAngle: 110, cct: 2700, dimming: 100, on: true, upRatio: 0.3, suspension: 0.6, diameter: 0.5 },
    rotation: { aimTilt: 0, aimAzimuth: 0, bodyRotation: 0 }, size: { diameter: 0.5, depth: 0.25 },
  },
};
/** Distance from the mount surface to the luminous centre (m): pendants hang, everything else sits on it. */
export function mountDrop(f) { return f.fixtureType === 'pendant' ? (f.photometricParameters.suspension ?? 0.6) : 0; }

let counter = 0;
export function newFixtureId() {
  const rnd = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `LF-${Date.now().toString(36).toUpperCase()}-${rnd}${(counter++).toString(36)}`;
}

/** New fixture design object. `position` is IFC world (m) of the luminous centre. */
export function createFixture(type, { roomId = null, roomExpressId = null, ifcProjectId = null, position = [0, 0, 0],
  mountHeight = null, mountReference = null, name = null } = {}) {
  const t = FIXTURE_TYPES[type];
  if (!t) throw new Error('unknown fixture type ' + type);
  return {
    fixtureId: newFixtureId(),
    name: name || `${t.label}`,
    fixtureType: type,
    catalogCode: t.code,
    roomId, roomExpressId, ifcProjectId,
    position: { ifcWorld: [...position], roomLocal: null },
    mountHeight,
    rotation: { ...t.rotation },
    mountReference: mountReference || { kind: 'manual', status: 'unverified' },
    photometricParameters: {
      ...t.defaults,
      length: t.defaults.length ?? null,
      distribution: DISTRIBUTION_MODEL,
      photometrySource: 'generic',       // no manufacturer data: simulated fixture
      ies: null,                         // reserved for future IES/LDT photometry
    },
    notes: '',
    designState: 'draft',                // future routing modules read fixtureId/type/position/designState
  };
}
