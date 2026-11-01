/* WEA Lighting — illuminance heat map (display of calculator output only).
 * Draws the work-plane samples of one room as coloured cells on a canvas texture mapped to a
 * horizontal plane at the work-plane height. Independent of the BIM geometry: BIM materials
 * are untouched, the plane is unlit (no tone mapping) and sits ≥ 2 cm above the floor so it
 * never shares a depth with the slab.
 */
import * as THREE from 'three';

// false-colour stops (value 0..1 -> sRGB)
export const LUX_STOPS = [[0, '#0b1d51'], [0.15, '#1f4fbf'], [0.35, '#1fa7b8'], [0.55, '#6cc950'], [0.75, '#f0d43a'], [0.9, '#f08a2c'], [1, '#d93a2b']];
const STOP_RGB = LUX_STOPS.map(([t, h]) => [t, new THREE.Color(h)]);

export function luxColor(v, max) {
  const t = Math.max(0, Math.min(1, max > 0 ? v / max : 0));
  for (let i = 1; i < STOP_RGB.length; i++) if (t <= STOP_RGB[i][0]) {
    const [t0, c0] = STOP_RGB[i - 1], [t1, c1] = STOP_RGB[i];
    return c0.clone().lerp(c1, (t - t0) / (t1 - t0));
  }
  return STOP_RGB.at(-1)[1].clone();
}

/** Round up to a readable legend maximum (1, 2, 2.5, 5 × 10^n). */
export function niceMax(v) {
  if (!(v > 0)) return 100;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  return [1, 2, 2.5, 5, 10].map(k => k * p).find(k => k >= v);
}

export class IlluminanceHeatmap {
  constructor(viewer, frames) {
    this.viewer = viewer; this.frames = frames; this.mesh = null;
    this.canvas = document.createElement('canvas'); this.texture = null;
  }
  clear() {
    if (this.mesh) {
      const i = this.viewer.pickHidden.indexOf(this.mesh); if (i >= 0) this.viewer.pickHidden.splice(i, 1);
      this.viewer.scene.remove(this.mesh); this.mesh.geometry.dispose(); this.mesh.material.dispose(); this.texture?.dispose();
    }
    this.mesh = null; this.texture = null;
  }
  /** grid: photometry.workplaneGrid output; values: lux per point; floor: room floor (local z). */
  show(grid, values, { legendMax, showValues, floor, blocked = null }) {
    const isBlocked = blocked ? new Set(blocked) : null;   // sensors inside objects (simulation): grey, no value
    this.clear();
    if (!grid.points.length) return;
    const px = Math.max(8, Math.min(56, Math.floor(2048 / Math.max(grid.nx, grid.ny))));
    const c = this.canvas; c.width = grid.nx * px; c.height = grid.ny * px;
    const g = c.getContext('2d'); g.clearRect(0, 0, c.width, c.height);
    grid.index.forEach(([i, j], k) => {
      g.fillStyle = isBlocked?.has(k) ? '#4a4e54' : '#' + luxColor(values[k], legendMax).getHexString();
      g.fillRect(i * px, (grid.ny - 1 - j) * px, px, px);
    });
    if (showValues && px >= 18) {
      g.font = `600 ${Math.floor(px * 0.34)}px Inter, Arial, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
      grid.index.forEach(([i, j], k) => {
        if (isBlocked?.has(k)) return;
        const v = values[k], t = legendMax > 0 ? v / legendMax : 0;
        g.fillStyle = t > 0.45 && t < 0.85 ? '#1b1f14' : '#f4f6f0';
        g.fillText(v >= 100 ? Math.round(v) : v.toFixed(v >= 10 ? 0 : 1), (i + 0.5) * px, (grid.ny - 1 - j + 0.5) * px);
      });
    }
    this.texture = new THREE.CanvasTexture(c); this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.magFilter = THREE.NearestFilter; this.texture.minFilter = THREE.LinearFilter;
    const w = grid.nx * grid.spacing, h = grid.ny * grid.spacing;
    const geo = new THREE.PlaneGeometry(w, h); geo.rotateX(-Math.PI / 2);       // plane +Y -> view −Z = IFC +Y
    const mat = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, opacity: 0.82, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
    this.mesh = new THREE.Mesh(geo, mat);
    const z = Math.max(grid.z, floor + 0.02);                                     // never coplanar with the floor
    this.mesh.position.set(...this.frames.localToView([grid.origin[0] + w / 2, grid.origin[1] + h / 2, z]));
    this.mesh.renderOrder = 10; this.mesh.name = 'lux-heatmap';
    this.viewer.scene.add(this.mesh); this.viewer.pickHidden.push(this.mesh);
  }
}
