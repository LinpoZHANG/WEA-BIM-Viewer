/* WEA Lighting — Visual Preview (three.js), separate from the illuminance calculation.
 * Reads the same fixture records and the same photometry functions as the calculator, so
 * position, aim, flux, beam and dimming always agree; only the presentation differs.
 *
 * Each point emitter (photometry.fixtureEmitters) becomes a three.js SpotLight with
 *   intensity = I0 (cd), decay 2, distance 0  ->  E = I(θ)·cosα / r²  (physically based units)
 *   angle     = visual cut-off where I < 0.5 % I0, penumbra encodes the cos^m exponent
 *               (decoded by the patched getSpotAttenuation in main.js).
 * Colour is the CCT approximation normalised to unit luminance (colour does not change the
 * light amount). Shadow maps are optional and limited (WebGL varying/texture budget); light
 * passes through un-shadowed geometry in the preview.
 *
 * Light budget (performance): forward rendering shades every pixel once per light, so the
 * preview uses a FIXED pool of `budget` lights (default 16) whatever the number of fixtures — the
 * frame cost stays constant and shaders never recompile when fixtures are added. Lights go to
 * the emitters that matter for the current picture (selected fixture, current room, near the
 * view focus, bright); the remaining fixtures are merged per room into equivalent diffuse lights
 * (summed flux at the flux-weighted centre), so rooms keep a plausible overall brightness. Linear
 * fixtures are one light in the preview. The illuminance calculation is not affected: it always
 * uses every emitter of every fixture (photometry.js).
 */
import * as THREE from 'three';
import { fixtureEmitters, cutoffAngle, cctToRgb, effectiveFlux, peakIntensity, LUMINOUS } from './photometry.js';

export const PREVIEW_LIGHT_BUDGET = 16;
export const MAX_SHADOW_LIGHTS = 6;
const ACCENT = new THREE.Color('#d7f16b');

export class LightingPreview {
  constructor(viewer, frames) {
    this.viewer = viewer; this.frames = frames;
    this.group = new THREE.Group(); this.group.name = 'lighting-preview';
    this.bodies = new THREE.Group(); this.beams = new THREE.Group(); this.lights = new THREE.Group();
    this.group.add(this.lights, this.bodies, this.beams);
    viewer.scene.add(this.group); viewer.pickHidden.push(this.group);   // not BIM geometry: excluded from GPU pick / AO passes
    this.pool = []; this.bodyByFixture = new Map(); this.shadowed = 0; this.enabled = false;
    this.group.visible = false;
  }
  setEnabled(on) { this.enabled = on; this.group.visible = on; this.viewer.invalidateShadows(); }
  dispose() { this.viewer.scene.remove(this.group); const i = this.viewer.pickHidden.indexOf(this.group); if (i >= 0) this.viewer.pickHidden.splice(i, 1); }

  /** fixed pool: the number of lights in the scene (and so the shader) never depends on the design */
  setBudget(n) {
    n = Math.max(4, Math.min(64, n | 0)); if (this.pool.length === n) return;
    for (const L of this.pool) { this.lights.remove(L, L.target); L.dispose?.(); }
    this.pool = [];
    for (let k = 0; k < n; k++) {
      const L = new THREE.SpotLight(0xffffff, 0, 0, Math.PI / 4, 0, 2);
      L.shadow.mapSize.set(1024, 1024); L.shadow.bias = -0.0004; L.shadow.normalBias = 0.02;
      L.shadow.camera.near = 0.05; L.shadow.camera.far = 40;
      this.lights.add(L, L.target); this.pool.push(L);
    }
  }

  /** Rebuild bodies and reassign lights. opts: { roomId, shadows, beams, bodies, selectedId, focus (IFC local) } */
  sync(fixtures, opts) {
    if (!this.pool.length) this.setBudget(PREVIEW_LIGHT_BUDGET);
    this.fixtures = fixtures; this.opts = opts;
    this.relight(opts.focus);
    this._bodies(fixtures, opts);
  }

  /** Assign the light pool for a view focus (IFC local point). Cheap: no geometry is rebuilt. */
  relight(focus = this.opts?.focus) {
    const F = this.frames, opts = this.opts || {}, cands = [];
    for (const f of this.fixtures || []) {
      const ph = f.photometricParameters; if (effectiveFlux(ph) <= 0) continue;
      const local = F.worldToLocal(f.position.ifcWorld);
      let em = fixtureEmitters(f, local).filter(e => e.flux > 0);
      if (f.fixtureType === 'linear' && em.length > 1) {                 // one light per linear fixture in the preview
        const flux = em.reduce((a, e) => a + e.flux, 0); em = [{ ...em[0], p: local, flux, I0: peakIntensity(flux, em[0].m) }];
      }
      if (f.fixtureType === 'luminous' && em.length > 1) {               // luminous surface: one cos¹ light per facing direction
        const groups = new Map();
        for (const e of em) {
          const n = e.axis, k = Math.abs(n[2]) > 0.7 ? (n[2] > 0 ? 'u' : 'd') : Math.abs(n[0]) > Math.abs(n[1]) ? (n[0] > 0 ? 'e' : 'w') : (n[1] > 0 ? 'n' : 's');
          const g = groups.get(k) || { flux: 0, p: [0, 0, 0], a: [0, 0, 0] };
          g.flux += e.flux; for (let i = 0; i < 3; i++) { g.p[i] += e.p[i] * e.flux; g.a[i] += e.axis[i] * e.flux; } groups.set(k, g);
        }
        em = [...groups.values()].map(g => { const l = Math.hypot(...g.a) || 1; return { p: g.p.map(v => v / g.flux), axis: g.a.map(v => v / l), m: 1, flux: g.flux, I0: peakIntensity(g.flux, 1) }; });
      }
      for (const e of em) {
        const d2 = focus ? (e.p[0] - focus[0]) ** 2 + (e.p[1] - focus[1]) ** 2 + (e.p[2] - focus[2]) ** 2 : 1;
        const score = f.fixtureId === opts.selectedId ? Infinity : e.flux * (f.roomId === opts.roomId ? 4 : 1) / (1 + d2);
        cands.push({ f, e, score });
      }
    }
    cands.sort((a, b) => b.score - a.score);
    const n = this.pool.length, reserve = cands.length > n ? Math.min(4, Math.floor(n / 4)) : 0;
    const direct = cands.slice(0, n - reserve), rest = cands.slice(n - reserve);
    // remaining emitters: one equivalent diffuse light per room (largest unlit flux first)
    const byRoom = new Map();
    for (const c of rest) { const k = c.f.roomId || '?'; const g = byRoom.get(k) || { flux: 0, p: [0, 0, 0], n: 0, cct: 0 }; g.flux += c.e.flux; for (let i = 0; i < 3; i++) g.p[i] += c.e.p[i] * c.e.flux; g.cct += c.f.photometricParameters.cct * c.e.flux; g.n++; byRoom.set(k, g); }
    const clusters = [...byRoom.values()].sort((a, b) => b.flux - a.flux).slice(0, reserve)
      .map(g => ({ e: { p: g.p.map(v => v / g.flux), axis: [0, 0, -1], m: 1, flux: g.flux, I0: peakIntensity(g.flux, 1) }, cct: g.cct / g.flux, n: g.n }));
    const shadowSet = new Set(opts.shadows ? direct.filter(c => c.f.roomId === opts.roomId).sort((a, b) => b.e.flux - a.e.flux).slice(0, MAX_SHADOW_LIGHTS) : []);
    const roomEm = cands.filter(c => c.f.roomId === opts.roomId).length;
    this.shadowed = shadowSet.size; this.shadowLimited = opts.shadows && roomEm > MAX_SHADOW_LIGHTS;
    const items = [...direct.map(c => ({ e: c.e, cct: c.f.photometricParameters.cct, shadow: shadowSet.has(c) })), ...clusters.map(c => ({ e: c.e, cct: c.cct, shadow: false }))];
    this.pool.forEach((L, i) => {
      const it = items[i];
      if (!it) { L.intensity = 0; L.castShadow = false; return; }
      const e = it.e, p = F.localToView(e.p), a = F.dirLocalToView(e.axis);
      L.position.set(...p); L.target.position.set(p[0] + a[0], p[1] + a[1], p[2] + a[2]); L.target.updateMatrixWorld();
      const cut = Math.min(cutoffAngle(e.m), 85) * Math.PI / 180;
      const coneCos = Math.cos(cut), t = Math.min(1, Math.max(0, (e.m - 1) / 199));
      L.angle = cut; L.penumbra = 1 - Math.acos(coneCos + t * (1 - coneCos)) / cut;
      L.intensity = e.I0;                                  // candela
      const [r, g, b] = cctToRgb(it.cct);
      const col = new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);
      const Y = 0.2126 * col.r + 0.7152 * col.g + 0.0722 * col.b;
      L.color.copy(col.multiplyScalar(1 / Math.max(Y, 1e-4)));
      L.castShadow = it.shadow; L.shadow.focus = 1;
    });
    const dropped = Math.max(0, byRoom.size - clusters.length);
    this.stats = { emitters: cands.length, direct: direct.length, clusters: clusters.length, merged: rest.length, droppedRooms: dropped, budget: n };
    if (this.suspendShadows) this.viewer.requestRender(); else this.viewer.invalidateShadows();   // shadow maps redrawn once the drag ends
  }

  _bodies(fixtures, opts) {
    for (const o of [...this.bodies.children, ...this.beams.children]) { o.geometry?.dispose(); o.material?.dispose(); }
    this.bodies.clear(); this.beams.clear(); this.bodyByFixture.clear();
    const F = this.frames;
    for (const f of fixtures) {
      const ph = f.photometricParameters, rot = f.rotation;
      const local = F.worldToLocal(f.position.ifcWorld), p = F.localToView(local);
      const lit = effectiveFlux(ph) > 0, sel = f.fixtureId === opts.selectedId;
      const [r, gg, b] = cctToRgb(ph.cct);
      const mat = new THREE.MeshBasicMaterial({ color: lit ? new THREE.Color().setRGB(r, gg, b, THREE.SRGBColorSpace) : new THREE.Color(0x3a3d42), toneMapped: false });
      if (sel) mat.color.lerp(ACCENT, 0.55);
      if (f.fixtureType === 'luminous') {                                // the emitting faces themselves glow (2 mm proud of the element)
        const g = LUMINOUS.get(f.fixtureId); if (!g?.faces?.length) continue;
        const off = [local[0] - g.origin[0], local[1] - g.origin[1], local[2] - g.origin[2]], pos = [];
        for (const t of g.faces) for (const v of [t.a, t.b, t.c]) pos.push(...F.localToView([v[0] + off[0] + t.n[0] * 0.002, v[1] + off[1] + t.n[1] * 0.002, v[2] + off[2] + t.n[2] * 0.002]));
        const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        const L = g.area > 0 ? effectiveFlux(ph) / (Math.PI * g.area) : 0;   // displayed luminance (cd/m²) = what a camera sees
        const lm = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, toneMapped: true, polygonOffset: true, polygonOffsetFactor: -2 });
        lm.color.setRGB(r, gg, b, THREE.SRGBColorSpace);
        const c = lm.color; const Y = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b; c.multiplyScalar(L / Math.max(Y, 1e-4));
        if (!lit) lm.color.set(0x3a3d42);
        if (sel) { lm.toneMapped = false; lm.color.set(ACCENT); lm.transparent = true; lm.opacity = 0.75; }
        const m = new THREE.Mesh(geo, lm); m.userData.fixtureId = f.fixtureId; m.renderOrder = 4;
        m.onBeforeRender = () => { const cp = this.viewer.clippingPlanes; if (lm.clippingPlanes?.length !== cp.length) lm.needsUpdate = true; lm.clippingPlanes = cp; }; m.visible = opts.bodies !== false || lit;
        if (Math.hypot(...off) > 0.001 && g.all) {                       // moved off its element: the rest of the element moves too (the original is hidden)
          const em = new Set(g.faces), rest = [];
          for (const t of g.all) if (!em.has(t)) for (const v of [t.a, t.b, t.c]) rest.push(...F.localToView([v[0] + off[0], v[1] + off[1], v[2] + off[2]]));
          if (rest.length) {
            const rg = new THREE.BufferGeometry(); rg.setAttribute('position', new THREE.Float32BufferAttribute(rest, 3)); rg.computeVertexNormals();
            const bm = new THREE.MeshStandardMaterial({ color: 0xd8d8d4, roughness: 0.8, side: THREE.DoubleSide });
            const body = new THREE.Mesh(rg, bm);
            body.onBeforeRender = () => { const cp = this.viewer.clippingPlanes; if (bm.clippingPlanes?.length !== cp.length) bm.needsUpdate = true; bm.clippingPlanes = cp; };   // same section cut as the model
            body.userData.fixtureId = f.fixtureId; m.add(body);
          }
        }
        this.bodies.add(m); this.bodyByFixture.set(f.fixtureId, m); mat.dispose(); continue;
      }
      let geo;
      if (f.fixtureType === 'linear') geo = new THREE.BoxGeometry(ph.length || 1, 0.03, 0.045);
      else if (f.fixtureType === 'spotlight') geo = new THREE.CylinderGeometry(0.035, 0.03, 0.11, 20);
      else if (f.fixtureType === 'ceiling') { const d = (ph.diameter || 0.4) / 2; geo = new THREE.CylinderGeometry(d, d * 0.92, 0.07, 40); }
      else if (f.fixtureType === 'pendant') { const d = (ph.diameter || 0.5) / 2; geo = new THREE.CylinderGeometry(d * 0.35, d, Math.max(0.08, d * 0.45), 32, 1, true); }
      else geo = new THREE.CylinderGeometry(0.045, 0.045, 0.012, 24);
      const m = new THREE.Mesh(geo, mat);
      m.position.set(...p);
      m.quaternion.copy(orientation(F, rot, f.fixtureType));
      if (f.fixtureType === 'downlight') m.position.y += 0.004;        // bezel sits just under the ceiling, not in it
      m.userData.fixtureId = f.fixtureId; m.visible = opts.bodies !== false;
      m.renderOrder = 5;
      if (sel) { const edge = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: ACCENT })); m.add(edge); }
      if (f.fixtureType === 'pendant') {                                 // suspension cord up to the ceiling (view +Y)
        mat.side = THREE.DoubleSide;
        const cord = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, ph.suspension ?? 0.6, 0)]), new THREE.LineBasicMaterial({ color: 0x9a9fa5, toneMapped: false }));
        cord.quaternion.copy(m.quaternion).invert(); m.add(cord);
      }
      this.bodies.add(m); this.bodyByFixture.set(f.fixtureId, m);
      if ((opts.beams && sel) || opts.beams === 'all') this.beams.add(beamCone(F, f, local, sel));
    }
  }
}

/** Object orientation (view coords): local −Y = aim, local +X = body length direction. */
export function orientation(F, rot, type) {
  const D2R = Math.PI / 180;
  const t = (rot.aimTilt || 0) * D2R, az = (rot.aimAzimuth || 0) * D2R, b = (rot.bodyRotation || 0) * D2R;
  const aim = new THREE.Vector3(...F.dirLocalToView([Math.sin(t) * Math.cos(az), Math.sin(t) * Math.sin(az), -Math.cos(t)]));
  const body = new THREE.Vector3(...F.dirLocalToView([Math.cos(b), Math.sin(b), 0]));
  const y = aim.clone().negate(), x = body.sub(y.clone().multiplyScalar(body.dot(y))).normalize();
  if (x.lengthSq() < 1e-8) x.set(1, 0, 0);
  const z = new THREE.Vector3().crossVectors(x, y);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}

/** Inverse of orientation(): aim tilt/azimuth and body rotation from an object quaternion. */
export function rotationFromQuaternion(F, q) {
  const R2D = 180 / Math.PI;
  const y = new THREE.Vector3(0, 1, 0).applyQuaternion(q), x = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
  const aim = F.dirViewToLocal([-y.x, -y.y, -y.z]), bx = F.dirViewToLocal([x.x, x.y, x.z]);
  const tilt = Math.acos(Math.max(-1, Math.min(1, -aim[2]))) * R2D;
  const az = tilt < 0.01 ? 0 : Math.atan2(aim[1], aim[0]) * R2D;
  return { aimTilt: tilt, aimAzimuth: az, bodyRotation: Math.atan2(bx[1], bx[0]) * R2D };
}

/** FWHM beam cone down to 3 m (or the floor), drawn as lines. */
function beamCone(F, f, local, sel) {
  const ph = f.photometricParameters, half = ph.beamAngle / 2 * Math.PI / 180, len = Math.min(3, Math.max(0.5, f.mountHeight || 2.5));
  const r = Math.tan(half) * len, pts = [], seg = 32;
  for (let k = 0; k < seg; k++) {
    const a0 = k / seg * Math.PI * 2, a1 = (k + 1) / seg * Math.PI * 2;
    pts.push(r * Math.cos(a0), -len, r * Math.sin(a0), r * Math.cos(a1), -len, r * Math.sin(a1));
    if (k % 8 === 0) pts.push(0, 0, 0, r * Math.cos(a0), -len, r * Math.sin(a0));
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const line = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: sel ? ACCENT : 0xffe9b0, transparent: true, opacity: sel ? 0.9 : 0.35, toneMapped: false }));
  line.position.set(...F.localToView(local)); line.quaternion.copy(orientation(F, f.rotation, f.fixtureType));
  return line;
}
