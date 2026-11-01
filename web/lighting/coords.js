/* WEA Lighting — coordinate frames (all lengths in metres).
 *
 *   IFC world : Z-up, the IFC project's coordinates scaled to metres (what Archicad shows).
 *   IFC local : IFC world − manifest.origin (horizontal shift the converter applies to
 *               georeferenced models so float32 vertices stay precise; zero for most models).
 *   View      : three.js render coordinates, Y-up:  (x, y, z)_view = (xL, zL, −yL).
 *
 * Lighting designs store IFC world coordinates; calculations run in IFC local; only the
 * renderer uses view coordinates. Never treat view X/Y/Z as IFC coordinates.
 */
export function makeFrames(origin = [0, 0, 0]) {
  const o = [origin[0] || 0, origin[1] || 0, origin[2] || 0];
  const F = {
    origin: o,
    worldToLocal: ([x, y, z]) => [x - o[0], y - o[1], z - o[2]],
    localToWorld: ([x, y, z]) => [x + o[0], y + o[1], z + o[2]],
    localToView: ([x, y, z]) => [x, z, -y],
    viewToLocal: ([x, y, z]) => [x, -z, y],
    worldToView: p => F.localToView(F.worldToLocal(p)),
    viewToWorld: v => F.localToWorld(F.viewToLocal(v)),
    /** direction vectors: no translation */
    dirLocalToView: ([x, y, z]) => [x, z, -y],
    dirViewToLocal: ([x, y, z]) => [x, -z, y],
  };
  return F;
}
