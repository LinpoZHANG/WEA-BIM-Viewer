#!/usr/bin/env python3
"""WEA — material textures from an Archicad Wavefront export (OBJ + MTL + texture folder), read-only.

IFC geometry has no texture coordinates, and Archicad does not write textures into IFC. Its OBJ export does:
the MTL names every surface (= the IFC surface style name) and its texture file, and the OBJ carries
Archicad's own texture coordinates. From those this tool derives, per material and separately for
horizontal and vertical faces (area-weighted medians over all faces):
  - texture repeat size in metres along u and v: 1 / |∇u|, 1 / |∇v|   (∇ = gradient of the UV over the face)
  - orientation: on horizontal faces the plan angle of ∇u (wood floor direction …); on vertical faces
    whether u runs horizontally (0°) or vertically (90°)
and writes, without touching the geometry cache:
  assets/textures/<id>.jpg   web copies (≤ 1024 px, sRGB JPEG)
  assets/surfaces.json       { materials: { <surface name>: { texture, horizontal, vertical, mtl, archicad } } }
Archicad surface coefficients (diffuse / specular / transparency … read through the Archicad JSON API into
source/archicad/ac_surfaces.json) are merged when available.

Usage: .venv/bin/python tools/obj_textures.py source/archicad/obj/HY01_8539.obj assets [--surfaces source/archicad/ac_surfaces.json]
"""
import argparse, hashlib, json, math, re
from pathlib import Path
import numpy as np
from PIL import Image

MAX_PX = 1024


def parse_mtl(path):
    mats, cur = {}, None
    for line in Path(path).read_text('utf-8', errors='ignore').splitlines():
        k, _, rest = line.strip().partition(' ')
        if k == 'newmtl': cur = mats.setdefault(rest.strip(), {})
        elif cur is None: continue
        elif k in ('Ka', 'Kd', 'Ks'): cur[k] = [float(x) for x in rest.split()[:3]]
        elif k in ('Ns', 'd', 'Tr'): cur[k] = float(rest.split()[0])
        elif k == 'map_Kd': cur['map_Kd'] = rest.strip()
    return mats


def parse_obj(path):
    """-> V (n,3) mm, VT (m,2), faces: list of (material index, [v idx], [vt idx]), material names"""
    V, VT, faces, names, mi = [], [], [], {}, -1
    with open(path, encoding='utf-8', errors='ignore') as f:
        for line in f:
            if line.startswith('v '): V.append(line.split()[1:4])
            elif line.startswith('vt '): VT.append(line.split()[1:3])
            elif line.startswith('usemtl'): n = line[6:].strip(); mi = names.setdefault(n, len(names))
            elif line.startswith('f '):
                vi, ti = [], []
                for tok in line.split()[1:]:
                    p = tok.split('/')
                    vi.append(int(p[0])); ti.append(int(p[1]) if len(p) > 1 and p[1] else 0)
                faces.append((mi, vi, ti))
    V = np.asarray(V, float); VT = np.asarray(VT, float)
    return V, VT, faces, [n for n, _ in sorted(names.items(), key=lambda x: x[1])]


def gradients(V, VT, faces):
    """Per face (first non-degenerate triangle): normal, ∇u, ∇v (per mm), area (mm²). Faces without UV skipped."""
    out = []
    for mi, vi, ti in faces:
        if len(vi) < 3 or not all(ti): continue
        idx = [(i - 1 if i > 0 else len(V) + i) for i in vi]; tdx = [(i - 1 if i > 0 else len(VT) + i) for i in ti]
        P0, T0 = V[idx[0]], VT[tdx[0]]
        for k in range(1, len(idx) - 1):
            e1, e2 = V[idx[k]] - P0, V[idx[k + 1]] - P0
            n = np.cross(e1, e2); A2 = np.linalg.norm(n)
            if A2 < 1e-6: continue
            G = np.array([[e1 @ e1, e1 @ e2], [e1 @ e2, e2 @ e2]])
            dt1, dt2 = VT[tdx[k]] - T0, VT[tdx[k + 1]] - T0
            try: Gi = np.linalg.inv(G)
            except np.linalg.LinAlgError: continue
            a = Gi @ np.array([dt1[0], dt2[0]]); b = Gi @ np.array([dt1[1], dt2[1]])
            gu, gv = a[0] * e1 + a[1] * e2, b[0] * e1 + b[1] * e2
            area = sum(np.linalg.norm(np.cross(V[idx[j]] - P0, V[idx[j + 1]] - P0)) / 2 for j in range(1, len(idx) - 1))
            out.append((mi, n / A2, gu, gv, area)); break
    return out


def wmedian(values, weights):
    o = np.argsort(values); v, w = np.asarray(values)[o], np.asarray(weights)[o]; c = np.cumsum(w)
    return float(v[np.searchsorted(c, c[-1] / 2)])


def summarise(rows):
    """rows of (normal, gu, gv, area) -> horizontal / vertical mapping parameters (metres, degrees)"""
    res = {}
    for kind, sel in (('horizontal', lambda n: abs(n[2]) > 0.9), ('vertical', lambda n: abs(n[2]) < 0.1)):
        r = [x for x in rows if sel(x[0]) and np.linalg.norm(x[1]) > 1e-9 and np.linalg.norm(x[2]) > 1e-9]
        if not r: continue
        w = [x[3] for x in r]
        su = wmedian([1 / np.linalg.norm(x[1]) / 1000 for x in r], w)
        sv = wmedian([1 / np.linalg.norm(x[2]) / 1000 for x in r], w)
        if kind == 'horizontal':
            ang = wmedian([math.degrees(math.atan2(x[1][1], x[1][0])) % 180 for x in r], w)
            res[kind] = {'sizeU': round(su, 4), 'sizeV': round(sv, 4), 'angle': round(ang, 1), 'area_m2': round(sum(w) / 1e6, 2)}
        else:
            vert_u = sum(x[3] for x in r if abs(x[1][2]) / np.linalg.norm(x[1]) > 0.7) / sum(w)   # share of faces whose u runs vertically
            res[kind] = {'sizeU': round(su, 4), 'sizeV': round(sv, 4), 'rotation': 90 if vert_u > 0.5 else 0, 'area_m2': round(sum(w) / 1e6, 2)}
    return res


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('obj'); ap.add_argument('assets'); ap.add_argument('--surfaces')
    a = ap.parse_args()
    doc = build(a.obj, a.assets, a.surfaces)
    tex = {k: v for k, v in doc['materials'].items() if v.get('texture')}
    print(f"{len(doc['materials'])} materials, {len(tex)} with texture, {doc['textureFiles']} texture files")
    for k, v in sorted(tex.items()):
        print(f"  {k:<28} {v['texture']['source']:<34} H {v.get('horizontal')}  V {v.get('vertical')}")


def build(obj, assets, surfaces=None):
    """Derive texture data from an OBJ export and write assets/surfaces.json + assets/textures/. Returns the document."""
    obj = Path(obj); assets = Path(assets); (assets / 'textures').mkdir(parents=True, exist_ok=True)
    if not obj.with_suffix('.mtl').exists(): raise FileNotFoundError(f'缺少材质文件 {obj.with_suffix(".mtl").name}（与 OBJ 同名的 .mtl）')
    mtl = parse_mtl(obj.with_suffix('.mtl'))
    V, VT, faces, names = parse_obj(obj)
    grads = gradients(V, VT, faces)
    by = {}
    for mi, n, gu, gv, area in grads: by.setdefault(names[mi], []).append((n, gu, gv, area))
    ac = {s['name']: s for s in json.loads(Path(surfaces).read_text('utf-8'))} if surfaces and Path(surfaces).exists() else {}
    out, written = {}, {}
    for name, m in mtl.items():
        entry = {'mtl': {k: m[k] for k in ('Kd', 'Ks', 'Ns', 'd') if k in m}}
        if name in ac:
            s = ac[name]
            entry['archicad'] = {k: s[k] for k in ('ambientReflection', 'diffuseReflection', 'specularReflection', 'transparency', 'shine', 'emissionAttenuation') if k in s}
            entry['archicad']['color'] = [s['surfaceColor'][c] for c in ('red', 'green', 'blue')]
            if s.get('texture', {}).get('name'): entry['archicad']['texture'] = s['texture']['name']
        tex = m.get('map_Kd')
        if tex and (obj.parent / tex).exists():
            src = obj.parent / tex
            if src not in written:
                tid = hashlib.sha1(src.read_bytes()).hexdigest()[:12]
                im = Image.open(src).convert('RGB'); w, h = im.size
                if max(w, h) > MAX_PX: im.thumbnail((MAX_PX, MAX_PX), Image.LANCZOS)
                im.save(assets / 'textures' / f'{tid}.jpg', quality=88)
                avg = np.asarray(im, float).reshape(-1, 3).mean(0) / 255
                written[src] = {'id': tid, 'file': f'textures/{tid}.jpg', 'source': src.name, 'px': [w, h], 'average': [round(x, 4) for x in avg]}
            entry['texture'] = written[src]
            entry.update(summarise(by.get(name, [])))
        if entry.get('texture') or entry.get('archicad'): out[name] = entry
    doc = {'format': 'WEA_SURFACES_V1', 'source': obj.name, 'units': 'm', 'textureFiles': len(written),
           'note': 'texture sizes / orientation derived from Archicad OBJ texture coordinates (area-weighted medians); applied by triplanar projection in the viewer',
           'materials': out}
    (assets / 'surfaces.json').write_text(json.dumps(doc, ensure_ascii=False, indent=1, default=float), encoding='utf-8')
    return doc


if __name__ == '__main__':
    main()
