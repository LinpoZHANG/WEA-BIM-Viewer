#!/usr/bin/env python3
"""WEA room work areas for lighting design -> assets/rooms.json (separate from the geometry cache).

Reads the existing converter output (model.json + model.bin, WEA_WEBGL_V2) read-only and, for every
IfcSpace, derives in IFC local coordinates (Z-up, metres): footprint polygon, floor level, space top,
and the *measured* ceiling levels (lowest down-facing architectural surface above each 0.25 m
sample of the footprint) with coverage. Results that cannot be verified are flagged
(`needsConfirmation`) instead of guessed. model.json / model.bin are never modified.

Usage: .venv/bin/python tools/room_context.py assets/ [--ifc source/model.ifc]
"""
import argparse, hashlib, json, sys
from pathlib import Path
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ifc_convert_ios import ceiling_candidates, room_context

FORMAT = 'WEA_ROOMS_V1'


def load_triangles(outdir):
    """Per element: main (non-duplicate) triangles in IFC local coords (Z-up) from model.bin."""
    outdir = Path(outdir)
    m = json.loads((outdir / 'model.json').read_text('utf-8'))
    L, raw = m['layout'], (outdir / 'model.bin').read_bytes()
    n = L['vertices']
    view = lambda k, dt: np.frombuffer(raw, dt, n * L[k][2], L[k][0]).reshape(n, -1)
    pos = view('position', '<f4').astype(np.float64)
    el, cover, mat = view('element', '<u4')[:, 0], view('cover', '<u4')[:, 0], view('material', '<u2')[:, 0]
    opaque = np.array([x['opacity'] >= .999 for x in m['materials']])
    local = np.stack([pos[:, 0], -pos[:, 2], pos[:, 1]], 1)          # view (x, y, z) -> IFC local (x, -z, y)
    T = local.reshape(-1, 3, 3); te, tc, tm = el[::3], cover[::3], mat[::3]
    keep = tc == 0                                                   # coplanar duplicates are drawn only when hidden
    kept = {}
    order = np.argsort(te[keep], kind='stable'); Tk, ek, mk = T[keep][order], te[keep][order], tm[keep][order]
    bounds = np.flatnonzero(np.r_[True, np.diff(ek) != 0, True])
    for a, b in zip(bounds[:-1], bounds[1:]):
        i = int(ek[a])
        if m['elements'][i]['category'] == 7:
            kept[i] = (Tk[a:b], mk[a:b])                             # spaces: whole volume
        else:
            sel = opaque[mk[a:b]]                                    # mount surfaces must be opaque
            kept[i] = (Tk[a:b][sel], mk[a:b][sel])
    return m, kept


def _angle(c):
    """IfcCompoundPlaneAngleMeasure (deg, min, sec, millionths) -> decimal degrees."""
    if not c:
        return None
    sign = -1 if any(v < 0 for v in c) else 1
    parts = [abs(v) for v in c] + [0] * 4
    return sign * (parts[0] + parts[1] / 60 + parts[2] / 3600 + parts[3] / 3.6e9)


def site_info(f):
    """Location and true north from the IFC (used as daylight defaults; may be a template placeholder)."""
    import ifcopenshell.util.unit as uunit
    s = next(iter(f.by_type('IfcSite')), None)
    north = None
    for c in f.by_type('IfcGeometricRepresentationContext'):
        if not c.is_a('IfcGeometricRepresentationSubContext') and c.TrueNorth:
            north = list(c.TrueNorth.DirectionRatios[:2]); break
    return {'name': s.Name if s else None, 'latitude': _angle(s.RefLatitude) if s else None,
            'longitude': _angle(s.RefLongitude) if s else None,
            'elevation': (s.RefElevation or 0) * uunit.calculate_unit_scale(f) if s and s.RefElevation is not None else None,
            'trueNorth': north, 'source': 'IfcSite / IfcGeometricRepresentationContext.TrueNorth'}


def _curve_points(c):
    """Polyline vertices of an IfcGridAxis curve (IfcPolyline / IfcIndexedPolyCurve / IfcTrimmedCurve of IfcLine)."""
    if c.is_a('IfcPolyline'):
        return [list(p.Coordinates) for p in c.Points]
    if c.is_a('IfcIndexedPolyCurve'):
        pts = [list(p) for p in c.Points.CoordList]
        if not c.Segments:
            return pts
        out = []
        for seg in c.Segments:
            idx = [i - 1 for i in seg.wrappedValue] if seg.is_a('IfcLineIndex') else [seg.wrappedValue[0] - 1, seg.wrappedValue[-1] - 1]
            out += [pts[i] for i in idx if not out or pts[i] != out[-1]]
        return out
    if c.is_a('IfcTrimmedCurve') and c.BasisCurve.is_a('IfcLine'):
        t = [x for x in c.Trim1 + c.Trim2 if x.is_a('IfcCartesianPoint')]
        if len(t) == 2:
            return [list(t[0].Coordinates), list(t[1].Coordinates)]
    return None


def grid_axes(f, origin=(0, 0, 0)):
    """IfcGrid axes as plan line strings in IFC local coordinates (m), for drafting / positioning.
    Unsupported curve types are reported, never approximated."""
    import ifcopenshell.util.placement as uplace, ifcopenshell.util.unit as uunit
    scale = uunit.calculate_unit_scale(f)
    grids, skipped = [], 0
    for g in _by_type_safe(f, 'IfcGrid'):
        M = uplace.get_local_placement(g.ObjectPlacement) if g.ObjectPlacement else np.eye(4)
        storey = next((r.RelatingStructure for r in getattr(g, 'ContainedInStructure', []) or []), None)
        axes = []
        for family, attr in (('U', 'UAxes'), ('V', 'VAxes'), ('W', 'WAxes')):
            for a in getattr(g, attr, None) or []:
                pts = _curve_points(a.AxisCurve) if a.AxisCurve else None
                if not pts or len(pts) < 2:
                    skipped += 1; continue
                P = np.array([(p + [0, 0])[:3] for p in pts], float)
                W = (np.c_[P, np.ones(len(P))] @ M.T)[:, :3] * scale - np.asarray(origin, float)
                axes.append({'tag': a.AxisTag or '', 'family': family, 'points': [[round(x, 4), round(y, 4)] for x, y, _ in W]})
        if axes:
            grids.append({'guid': g.GlobalId, 'name': g.Name or 'Grid', 'storey': storey.Name if storey else None,
                          'elevation': round(float(M[2, 3]) * scale - origin[2], 4), 'axes': axes})
    return {'grids': grids, 'skippedAxes': skipped}


def _by_type_safe(f, name):
    try:
        return f.by_type(name)
    except RuntimeError:
        return []


def write_rooms(outdir, project=None, site=None, grids=None):
    outdir = Path(outdir)
    m, kept = load_triangles(outdir)
    elements = m['elements']
    candidates = ceiling_candidates(kept, elements)
    rooms = {}
    for i, e in enumerate(elements):
        if e['category'] == 7 and i in kept and len(kept[i][0]):
            ctx = room_context(kept[i][0], candidates, elements)
            if ctx:
                rooms[e['guid']] = {'expressId': e['id'], 'name': e['name'], **ctx}
    digest = hashlib.sha256((outdir / 'model.json').read_bytes()).hexdigest()[:16]
    doc = {'format': FORMAT, 'frame': 'IFC local (IFC world - model.origin), Z-up, metres',
           'source': {'model': m['name'], 'modelJsonSha256': digest}, 'project': project, 'site': site, 'rooms': rooms,
           'grids': (grids or {}).get('grids', []), 'gridAxesSkipped': (grids or {}).get('skippedAxes', 0)}
    (outdir / 'rooms.json').write_text(json.dumps(doc, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    return doc


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('outdir'); ap.add_argument('--ifc')
    a = ap.parse_args()
    project = site = grids = None
    if a.ifc:
        import ifcopenshell
        f = ifcopenshell.open(a.ifc)
        p = next(iter(f.by_type('IfcProject')), None)
        project = {'guid': p.GlobalId, 'name': p.Name or ''} if p else None
        site = site_info(f)
        grids = grid_axes(f, json.loads((Path(a.outdir) / 'model.json').read_text('utf-8')).get('origin') or (0, 0, 0))
    doc = write_rooms(a.outdir, project, site, grids)
    for g, r in doc['rooms'].items():
        print(f"{r['name']:<8} {r['area']:7.2f} m²  ceilings {[ (c['height'], c['coverage']) for c in r['ceilings'][:2]]}  {'需确认: ' + '；'.join(r['issues']) if r['needsConfirmation'] else ''}")
