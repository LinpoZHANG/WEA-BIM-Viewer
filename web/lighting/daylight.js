/* WEA Lighting — daylight in the Visual Preview: a shadow-casting directional sun for the chosen
 * date / time / location / true north. Visual only: sky light and inter-reflection are not shown
 * in the real-time preview; quantitative daylight comes from the Radiance simulation.
 */
import * as THREE from 'three';
import { solarPosition, sunVector, northRotation, previewSunIlluminance } from './sun.js';

export class DaylightPreview {
  constructor(viewer, frames) {
    this.viewer = viewer; this.frames = frames;
    this.light = new THREE.DirectionalLight(0xfff1dc, 0);
    this.light.shadow.mapSize.set(2048, 2048); this.light.shadow.bias = -0.0003; this.light.shadow.normalBias = 0.03;
    viewer.scene.add(this.light, this.light.target);
    this.position = null;
    // Sky dome instead of scene.background: it is tone-mapped like everything else, so the sky looks the
    // same directly and through transmissive glass (three.js tone-maps what is seen through glass).
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), new THREE.MeshBasicMaterial({ side: THREE.BackSide, depthWrite: false, fog: false }));
    this.dome.frustumCulled = false; this.dome.renderOrder = -10; this.dome.visible = false;
    this.dome.onBeforeRender = (r, s, cam) => { this.dome.position.copy(cam.position); this.dome.scale.setScalar(cam.far * 0.9); this.dome.updateMatrixWorld(); };
    viewer.scene.add(this.dome); viewer.pickHidden.push(this.dome);
  }
  dispose() { this.viewer.scene.remove(this.light, this.light.target, this.dome); const i = this.viewer.pickHidden.indexOf(this.dome); if (i >= 0) this.viewer.pickHidden.splice(i, 1); }
  /** settings: simulationSettings.daylight; room: RoomContext; active: lighting workspace shown */
  sync(settings, room, trueNorth, active, exposure = 1) {
    const L = this.light;
    this.position = solarPosition(settings);
    const on = active && settings.enabled && room;
    const E = on ? previewSunIlluminance(this.position.altitude, settings.sky) : 0;
    L.intensity = E; L.castShadow = E > 0; L.visible = E > 0;
    // sky behind the windows while daylight is on (display only); brightness compensates the exposure
    const day = on && this.position.altitude > 0;
    this.dome.visible = day;
    if (day) this.dome.material.color.set(settings.sky === 'overcast' ? '#c3c8cd' : settings.sky === 'intermediate' ? '#b7c9db' : '#9fc3e6').multiplyScalar(0.9 / Math.max(exposure, 1e-4));
    if (E > 0) {
      const F = this.frames, c = [(room.min[0] + room.max[0]) / 2, (room.min[1] + room.max[1]) / 2, room.floor + 1];
      const s = sunVector(this.position, northRotation(trueNorth, settings.northOffset));
      const target = F.localToView(c), dir = F.dirLocalToView(s);
      L.target.position.set(...target); L.target.updateMatrixWorld();
      L.position.set(target[0] + dir[0] * 60, target[1] + dir[1] * 60, target[2] + dir[2] * 60);
      const r = Math.max(room.max[0] - room.min[0], room.max[1] - room.min[1]) / 2 + 12;
      Object.assign(L.shadow.camera, { left: -r, right: r, top: r, bottom: -r, near: 1, far: 140 });
      L.shadow.camera.updateProjectionMatrix();
    }
    this.viewer.invalidateShadows();
    return { ...this.position, illuminance: E };
  }
}
