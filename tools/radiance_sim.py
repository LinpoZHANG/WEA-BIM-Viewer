#!/usr/bin/env python3
"""WEA Lighting — professional illuminance simulation with Radiance (LBNL, via pyradiance).

Inputs come from the lighting workspace (all lengths in metres, IFC local coordinates, Z-up):
  sensors   work-plane points + normal (the same grid the real-time estimate uses)
  emitters  luminaire point sources {p, axis, m, flux} from web/lighting/photometry.js, so the
            simulation uses exactly the same positions, aim and cos^m distributions; each is
            written as an IES LM-63 file and converted by Radiance's ies2rad
  daylight  CIE standard sky (gensky): clear with sun / intermediate / overcast, date, time,
            latitude, longitude, time-zone meridian, rotation to true north
Geometry is taken read-only from the converter output (assets/model.json + model.bin): every
element whose bounding box intersects the room expanded by `margin`, except IfcSpace volumes,
fully transparent "air" materials and coplanar duplicates. Opaque materials are Radiance
`plastic` with reflectance derived from the IFC display colour (or the designer's override);
transparent materials become `glass` (T >= 0.6) or diffusing `trans` (frosted).

Electric light and daylight are traced separately (Radiance is linear in its sources), so each
component can be switched off and both are reported. Illuminance = 179 · (0.265 R + 0.670 G + 0.065 B).
"""
import hashlib, json, math, os, shutil, subprocess, tempfile, threading, time
from pathlib import Path

import numpy as np
import pyradiance

BIN = str(pyradiance.BINPATH)
LIB = str(Path(BIN).parent / 'lib')
QUALITY = {   # Radiance ambient parameters (inter-reflection bounces / sampling). Measured on the sample
              # living room (483 points, 252k triangles, 8 cores): draft ~12 s, standard ~40 s per component.
    'draft':    {'ab': 2, 'ad': 512,  'as': 256,  'aa': 0.2,  'ar': 64,  'lw': 2e-3},
    'standard': {'ab': 4, 'ad': 1024, 'as': 512,  'aa': 0.15, 'ar': 128, 'lw': 5e-4},
    'high':     {'ab': 6, 'ad': 2048, 'as': 1024, 'aa': 0.1,  'ar': 256, 'lw': 1e-4},
    'direct':   {'ab': 0, 'ad': 64,   'as': 0,    'aa': 0.2,  'ar': 16,  'lw': 1e-3},   # validation only: no inter-reflection
}
SKIES = {'clear': '+s', 'intermediate': '+i', 'overcast': '-c'}
GROUND_REFLECTANCE = 0.2

_cache = {'key': None}
_cache_lock = threading.Lock()


def _srgb_to_linear(c):
    c = np.asarray(c, float)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def radiance_luminance(rgb):
    return 0.265 * rgb[0] + 0.670 * rgb[1] + 0.065 * rgb[2]


def load_model(assets):
    """Triangles (IFC local, Z-up) with material / element / cover, cached by file mtime."""
    assets = Path(assets)
    key = tuple((p.name, p.stat().st_mtime_ns) for p in (assets / 'model.json', assets / 'model.bin'))
    with _cache_lock:
        if _cache['key'] == key:
            return _cache['data']
        m = json.loads((assets / 'model.json').read_text('utf-8'))
        L, raw = m['layout'], (assets / 'model.bin').read_bytes()
        n = L['vertices']
        view = lambda k, dt: np.frombuffer(raw, dt, n * L[k][2], L[k][0]).reshape(n, -1)
        pos = view('position', '<f4').astype(np.float64)
        T = np.stack([pos[:, 0], -pos[:, 2], pos[:, 1]], 1).reshape(-1, 3, 3)   # view -> IFC local
        data = {'model': m, 'T': T, 'el': view('element', '<u4')[::3, 0].astype(np.int64),
                'cover': view('cover', '<u4')[::3, 0], 'mat': view('material', '<u2')[::3, 0].astype(np.int64)}
        lo, hi = T.min(1), T.max(1)
        ne = len(m['elements'])
        elo = np.full((ne, 3), np.inf); ehi = np.full((ne, 3), -np.inf)
        np.minimum.at(elo, data['el'], lo); np.maximum.at(ehi, data['el'], hi)
        data['elo'], data['ehi'] = elo, ehi
        _cache.update(key=key, data=data)
        return data


def material_defs(model, used, overrides):
    """Radiance material definitions + report rows for the materials in the scene."""
    lines, report = [], []
    for k in sorted(used):
        mt = model['materials'][k]
        lin = _srgb_to_linear(mt['color'])
        T = 1 - mt['opacity']
        name = f'm{k}'
        if T > 0.001:                                   # transparent (air volumes are excluded earlier)
            if T >= 0.6:
                tn = (math.sqrt(0.8402528435 + 0.0072522239 * T * T) - 0.9166530661) / 0.0036261119 / T
                tint = lin / max(lin.max(), 1e-6)
                c = [round(float(tn * v), 4) for v in tint]
                lines.append(f'void glass {name}\n0\n0\n3 {c[0]} {c[1]} {c[2]}\n')
                kind, rho = 'glass', None
            else:                                       # frosted: diffuse transmission
                rho = 0.1; tot = min(0.95, rho + T)
                lines.append(f'void trans {name}\n0\n0\n7 {tot:.4f} {tot:.4f} {tot:.4f} 0 0 {T / tot:.4f} 0\n')
                kind = 'trans'
            report.append({'index': k, 'name': mt['name'], 'type': kind, 'transmittance': round(T, 3),
                           'reflectance': rho, 'default': None, 'override': False})
            continue
        default = float(np.clip(radiance_luminance(lin), 0.02, 0.9))
        rho = overrides.get(mt['name'])
        rho = float(np.clip(rho, 0.01, 0.95)) if isinstance(rho, (int, float)) else default
        rgb = lin * (rho / max(radiance_luminance(lin), 1e-6))
        rgb = np.clip(rgb, 0, 0.98)
        lines.append(f'void plastic {name}\n0\n0\n5 {rgb[0]:.4f} {rgb[1]:.4f} {rgb[2]:.4f} 0 0\n')
        report.append({'index': k, 'name': mt['name'], 'type': 'opaque', 'reflectance': round(rho, 3),
                       'default': round(default, 3), 'override': mt['name'] in overrides})
    return ''.join(lines), report


def ies_text(flux, m, label):
    """IES LM-63-2002 file of the generic cos^m distribution (photometric type C, symmetric)."""
    I0 = flux * (m + 1) / (2 * math.pi)
    ang = [i * 1.25 for i in range(145)]                                   # 0 .. 180 deg
    cd = [I0 * math.cos(math.radians(a)) ** m if a < 90 else 0.0 for a in ang]
    return ('IESNA:LM-63-2002\n[TEST] WEA generic simulated luminaire\n[MANUFAC] generic (no manufacturer photometry)\n'
            f'[LUMINAIRE] {label}\nTILT=NONE\n'
            f'1 {flux:.3f} 1 {len(ang)} 1 1 2 -0.05 0 0\n1 1 0\n'
            + ' '.join(f'{a:g}' for a in ang) + '\n0\n' + ' '.join(f'{c:.4f}' for c in cd) + '\n')


def _run(args, cwd, inp=None):
    env = {**os.environ, 'RAYPATH': f'.{os.pathsep}{LIB}'}
    r = subprocess.run([os.path.join(BIN, args[0])] + [str(a) for a in args[1:]], cwd=cwd, input=inp,
                       capture_output=True, env=env)
    if r.returncode:
        raise RuntimeError(f'{args[0]} failed: {r.stderr.decode(errors="replace")[:400]}')
    return r.stdout


def _rtrace(octree, sensors, normal, q, cwd, progress, label, extra=()):
    args = [os.path.join(BIN, 'rtrace'), '-I', '-h', '-n', str(max(1, (os.cpu_count() or 2) - 1)),
            '-ab', q['ab'], '-ad', q['ad'], '-as', q['as'], '-aa', q['aa'], '-ar', q['ar'], '-lw', q['lw'],
            '-af', f'{label}.amb', *extra, octree]
    env = {**os.environ, 'RAYPATH': f'.{os.pathsep}{LIB}'}
    inp = ''.join(f'{x} {y} {z} {normal[0]} {normal[1]} {normal[2]}\n' for x, y, z in sensors).encode()
    p = subprocess.Popen([str(a) for a in args], cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
    out_lines = []
    def feed():
        p.stdin.write(inp); p.stdin.close()
    threading.Thread(target=feed, daemon=True).start()
    for line in p.stdout:
        out_lines.append(line)
        if len(out_lines) % 20 == 0:
            progress(label, len(out_lines) / max(1, len(sensors)))
    err = p.stderr.read().decode(errors='replace'); p.wait()
    if p.returncode:
        raise RuntimeError('rtrace failed: ' + err[:400])
    vals = np.array([[float(v) for v in l.split()[:3]] for l in out_lines if l.strip()])
    if len(vals) != len(sensors):
        raise RuntimeError(f'rtrace returned {len(vals)} of {len(sensors)} values')
    return 179.0 * (0.265 * vals[:, 0] + 0.670 * vals[:, 1] + 0.065 * vals[:, 2])


PROBE_DIRS = np.array([[0, 0, 1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]], float)


def enclosed_sensors(octree, sensors, cwd, reach=2.0):
    """True where a sensor sits inside an object or wall layer: a probe ray (up / ±X / ±Y) reaches the
    back side of a surface within `reach` m, i.e. the point is enclosed by that surface."""
    env = {**os.environ, 'RAYPATH': f'.{os.pathsep}{LIB}'}
    inp = ''.join(f'{x} {y} {z} {d[0]} {d[1]} {d[2]}\n' for x, y, z in sensors for d in PROBE_DIRS).encode()
    out = subprocess.run([os.path.join(BIN, 'rtrace'), '-h', '-ab', '0', '-oNL', octree], cwd=cwd, input=inp,
                         capture_output=True, env=env, check=True).stdout.decode().split('\n')
    vals = np.array([[float(v) for v in l.split()] for l in out if l.strip()]).reshape(len(sensors), len(PROBE_DIRS), 4)
    facing = (vals[:, :, :3] * PROBE_DIRS[None]).sum(2)          # > 0: the hit surface faces away from the sensor
    dist = vals[:, :, 3]
    return ((facing > 0.2) & (dist > 0) & (dist < reach)).any(1)


def sky_text(d, cwd):
    """CIE sky (+sun) for the date/time/location, rotated so Radiance north (+Y) matches true north."""
    args = ['gensky', int(d['month']), int(d['day']), float(d['hour']), SKIES[d.get('sky', 'clear')],
            '-a', float(d['latitude']), '-o', -float(d['longitude']), '-m', -15.0 * float(d['timezone']),
            '-g', GROUND_REFLECTANCE]
    sky = _run(args, cwd).decode()
    sun = None
    for line in sky.splitlines():
        if 'Solar altitude and azimuth' in line:
            a, z = line.split(':')[1].split()[:2]; sun = {'altitude': float(a), 'azimuth': float(z)}   # azimuth from south, + west
    rot = float(d.get('northRotation', 0))        # degrees, CCW about Z, applied to the sky
    sky += ('\nskyfunc glow sky_glow\n0\n0\n4 1 1 1 0\nsky_glow source sky\n0\n0\n4 0 0 1 180\n'
            'skyfunc glow ground_glow\n0\n0\n4 1 1 1 0\nground_glow source ground\n0\n0\n4 0 0 -1 180\n')
    (Path(cwd) / 'sky_raw.rad').write_text(sky)
    return _run(['xform', '-rz', rot, 'sky_raw.rad'], cwd).decode(), sun


def simulate(req, assets, progress=lambda phase, frac: None):
    t0 = time.time()
    data = load_model(assets); model = data['model']
    room = req['room']; margin = float(req.get('margin', 6.0))
    sensors = np.asarray(req['sensors'], float); normal = req.get('normal', [0, 0, 1])
    q = QUALITY[req.get('quality', 'standard')]
    fp = np.asarray(room['footprint'], float)
    lo = np.array([fp[:, 0].min() - margin, fp[:, 1].min() - margin, room['floor'] - 1.0])
    hi = np.array([fp[:, 0].max() + margin, fp[:, 1].max() + margin, (room.get('ceiling') or room['floor'] + 3) + 1.5])
    # elements in the region (whole elements, so slabs/walls are never cut open)
    els = model['elements']
    inregion = np.all(data['elo'] <= hi, 1) & np.all(data['ehi'] >= lo, 1)
    excluded_el = np.array([e['category'] == 7 for e in els])
    if req.get('elementGuids'):                       # interior envelope from the viewer: only elements visible from inside
        allowed = set(req['elementGuids'])
        excluded_el |= np.array([e['guid'] not in allowed for e in els])
    opac = np.array([mt['opacity'] for mt in model['materials']])
    tri = inregion[data['el']] & ~excluded_el[data['el']] & (data['cover'] == 0) & (opac[data['mat']] >= 0.02)
    T, M = data['T'][tri], data['mat'][tri]
    if not len(T):
        raise ValueError('仿真区域内没有建筑几何')
    work = Path(tempfile.mkdtemp(prefix='wea-rad-'))
    try:
        progress('scene', 0)
        mats, mat_report = material_defs(model, set(M.tolist()), req.get('materialReflectance', {}))
        (work / 'materials.rad').write_text(mats)
        area = 0.5 * np.linalg.norm(np.cross(T[:, 1] - T[:, 0], T[:, 2] - T[:, 0]), axis=1)
        for r in mat_report:
            r['area'] = round(float(area[M == r['index']].sum()), 2)
        # OBJ grouped by material, absolute vertex indices -> Radiance mesh (obj2mesh)
        with open(work / 'scene.obj', 'w') as fh:
            vi = 1
            for k in sorted(set(M.tolist())):
                S = T[M == k]
                fh.write(f'usemtl m{k}\n')
                fh.write(''.join(f'v {x:.5f} {y:.5f} {z:.5f}\n' for x, y, z in S.reshape(-1, 3)))
                fh.write(''.join(f'f {vi + 3 * j} {vi + 3 * j + 1} {vi + 3 * j + 2}\n' for j in range(len(S))))
                vi += 3 * len(S)
        _run(['obj2mesh', '-a', 'materials.rad', 'scene.obj', 'scene.rtm'], work)
        (work / 'scene.rad').write_text('void mesh bim\n1 scene.rtm\n0\n0\n')
        (work / 'geometry.oct').write_bytes(_run(['oconv', '-f', 'materials.rad', 'scene.rad'], work))
        progress('scene', 1)
        blocked = enclosed_sensors('geometry.oct', sensors, work)
        result = {'sensors': len(sensors), 'components': {}, 'materials': mat_report, 'quality': req.get('quality', 'standard'),
                  'parameters': q, 'region': {'min': lo.round(3).tolist(), 'max': hi.round(3).tolist(), 'margin': margin,
                  'triangles': int(len(T)), 'elements': int(np.unique(data['el'][tri]).size)}, 'warnings': [],
                  'blocked': np.flatnonzero(blocked).tolist()}
        if blocked.any():
            result['warnings'].append(f'{int(blocked.sum())} 个采样点位于家具或构件内部（不计入统计，热力图显示为灰色）')
        # electric light
        emitters = [e for e in req.get('emitters', []) if e.get('flux', 0) > 0]
        areas = [a for a in req.get('areaSources', []) if a.get('luminance', 0) > 0 and a.get('triangles')]
        if req.get('electric', True):
            if emitters or areas:
                lum = []
                # luminous surfaces: Radiance `light` (uniform radiance, front side = counter-clockwise normal);
                # luminance L cd/m² -> radiance L / 179 W/sr/m² (Radiance luminous efficacy), grey (CCT only tints the preview)
                for i, a in enumerate(areas):
                    r = a['luminance'] / 179.0
                    lum.append(f'void light lumarea{i}\n0\n0\n3 {r:.6g} {r:.6g} {r:.6g}\n')
                    for j, t in enumerate(a['triangles']):
                        lum.append(f'lumarea{i} polygon la{i}_{j}\n0\n0\n9 ' + ' '.join(f'{v:.5f}' for p in t for v in p) + '\n')
                for i, e in enumerate(emitters):
                    name = f'lum{i}'
                    (work / f'{name}.ies').write_text(ies_text(e['flux'], e['m'], e.get('label', name)))
                    _run(['ies2rad', '-dm', '-c', 1, 1, 1, '-o', name, f'{name}.ies'], work)
                    ax = np.asarray(e['axis'], float); ax /= np.linalg.norm(ax)
                    tilt = math.degrees(math.acos(max(-1, min(1, -ax[2]))))
                    az = math.degrees(math.atan2(ax[1], ax[0]))
                    x, y, z = e['p']
                    lum.append(_run(['xform', '-ry', -tilt, '-rz', az, '-t', x, y, z, f'{name}.rad'], work).decode())
                (work / 'lum.rad').write_text(''.join(lum))
                (work / 'electric.oct').write_bytes(_run(['oconv', '-i', 'geometry.oct', 'lum.rad'], work))
                result['components']['electric'] = _rtrace('electric.oct', sensors, normal, q, work, progress, 'electric').round(2).tolist()
            else:
                result['components']['electric'] = [0.0] * len(sensors)
                result['warnings'].append('本房间没有开启的灯具')
        # daylight
        day = req.get('daylight') or {}
        if day.get('enabled'):
            sky, sun = sky_text(day, work)
            (work / 'sky.rad').write_text(sky)
            (work / 'daylight.oct').write_bytes(_run(['oconv', '-i', 'geometry.oct', 'sky.rad'], work))
            qd = dict(q); qd['ab'] = max(q['ab'], 3 if q['ab'] > 2 else 2)   # skylight indoors needs bounces
            result['components']['daylight'] = _rtrace('daylight.oct', sensors, normal, qd, work, progress, 'daylight').round(2).tolist()
            result['sun'] = sun
            if sun and sun['altitude'] <= 0:
                result['warnings'].append('所选时刻太阳在地平线以下（仅天空光/无直射日光）')
        comps = list(result['components'].values())
        total = np.sum(comps, 0) if comps else np.zeros(len(sensors))
        result['total'] = total.round(2).tolist()
        # with inter-reflection no visible point of a lit room is exactly dark: such points lie in cavities / wall layers
        if total.max() > 0:
            dark = np.flatnonzero((total <= 1e-6 * total.max()) & ~blocked)
            if len(dark):
                result['blocked'] = sorted(set(result['blocked']) | set(dark.tolist()))
                result['warnings'].append(f'{len(dark)} 个采样点完全未受光（多位于构件夹层或墙体内，IfcSpace 边界可能超出墙面），不计入统计')
        result['seconds'] = round(time.time() - t0, 1)
        return result
    finally:
        shutil.rmtree(work, ignore_errors=True)

