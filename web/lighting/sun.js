/* WEA Lighting — solar position for the visual daylight preview (pure module).
 * Low-precision astronomical algorithm (Astronomical Almanac / NOAA style, ~0.3° accuracy),
 * cross-checked against Radiance gensky in tests. The Radiance simulation computes its own sun
 * with gensky; this is only used to place the preview sun light in the viewport.
 */
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const mod = (a, b) => ((a % b) + b) % b;

/** Sun altitude and azimuth (deg, azimuth clockwise from true north) at local standard time. */
export function solarPosition({ year = 2026, month, day, hour, latitude, longitude, timezone }) {
  const ms = Date.UTC(year, month - 1, day) + (hour - timezone) * 3600e3;
  const n = ms / 86400000 + 2440587.5 - 2451545.0;                  // days since J2000.0
  const L = mod(280.460 + 0.9856474 * n, 360), g = mod(357.528 + 0.9856003 * n, 360) * D2R;
  const lambda = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * D2R;
  const eps = (23.439 - 0.0000004 * n) * D2R;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const gmst = mod(18.697374558 + 24.06570982441908 * n, 24);
  const H = (gmst * 15 + longitude) * D2R - ra, phi = latitude * D2R;
  const alt = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
  const az = Math.atan2(-Math.sin(H), Math.tan(dec) * Math.cos(phi) - Math.sin(phi) * Math.cos(H));
  return { altitude: alt * R2D, azimuth: mod(az * R2D, 360) };
}

/** Rotation (deg, CCW about IFC Z) that turns model +Y onto true north given IfcGeometricRepresentationContext.TrueNorth. */
export function northRotation(trueNorth, offsetDeg = 0) {
  const [nx, ny] = trueNorth && (trueNorth[0] || trueNorth[1]) ? trueNorth : [0, 1];
  return Math.atan2(-nx, ny) * R2D + offsetDeg;
}

/** Unit vector towards the sun in IFC local coordinates (Z-up), model rotated by `rotationDeg`. */
export function sunVector(pos, rotationDeg = 0) {
  const a = pos.azimuth * D2R, h = pos.altitude * D2R, r = rotationDeg * D2R;
  const x = Math.sin(a) * Math.cos(h), y = Math.cos(a) * Math.cos(h);          // east = +X, north = +Y
  return [x * Math.cos(r) - y * Math.sin(r), x * Math.sin(r) + y * Math.cos(r), Math.sin(h)];
}

/** Rough direct-normal sun illuminance (lux) for the preview only: E = 127.5 klx · exp(−0.21·airmass). */
export function previewSunIlluminance(altitudeDeg, sky) {
  if (altitudeDeg <= 0 || sky === 'overcast') return 0;
  const m = 1 / (Math.sin(altitudeDeg * D2R) + 0.50572 * Math.pow(altitudeDeg + 6.07995, -1.6364));
  return 127500 * Math.exp(-0.21 * m) * (sky === 'intermediate' ? 0.5 : 1);
}
