#!/usr/bin/env python3
"""WEA IFC -> WebGL converter backed by the IfcOpenShell geometry kernel.

Generic pipeline for any IFC2X3 / IFC4 / IFC4X3 STEP file:
1. Metadata: storeys, containment, Psets, entity-based categories (name/Pset
   heuristics only for IfcBuildingElementProxy and other untyped elements).
2. Geometry: IfcOpenShell/OpenCASCADE evaluates every representation type (swept
   solids, booleans, mapped items, faces with voids, non-convex polygons) and
   subtracts openings. Only 3D body representations are meshed; elements whose
   body lives in another 3D context fall back to it (never Box/Axis/FootPrint).
   Not rendered: opening/voiding features, virtual elements, and assemblies whose
   parts carry their own geometry (parent + parts would be drawn twice).
3. Precision: georeferenced models (|XY| > 1 km) are shifted to a local origin
   before float32 packing; the shift is recorded in the manifest ('origin').
4. Coplanar overlap resolution: same-facing faces of different elements (or of
   one element's layers) lying within ~1.5 mm and overlapping in projection
   would z-fight. The front-most face is kept; the overlapped part of faces
   behind it is cut. Pieces cut from *another* element's face are stored as
   duplicate ranges that the viewer draws only while their cover is hidden,
   so the surface never z-fights yet never shows a hole when filtering.

5. Appearance: IfcSurfaceStyle colour / transparency / specularity per triangle
   (via IfcOpenShell), plus per-face IfcIndexedColourMap colours, which the
   kernel does not apply (matched back to faces geometrically). Crease-angle
   vertex normals so curved MEP parts shade smoothly while edges stay sharp.

Output is the WEA_WEBGL_V2 layout: planar, non-indexed vertex arrays (Y-up metres)
described by manifest['layout']: position f32x3, normal i8x4, element u32,
cover u32 (index+1 of the element whose identical face hides this one, 0 = none),
material u16. Opaque vertices first, then transparent.
Requires: ifcopenshell, numpy, shapely (see requirements.txt).
"""
import collections, json, multiprocessing, sys, time
from pathlib import Path

import numpy as np
import shapely
from shapely.geometry import Polygon
import ifcopenshell
import ifcopenshell.geom
import ifcopenshell.util.element as uel
import ifcopenshell.util.placement as uplace
import ifcopenshell.util.unit as uunit

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ifc_convert import classify  # name/Pset heuristic for proxies

PLANE_BIN = 0.003      # m: plane-offset bin; two shifted passes catch every pair < 1.5 mm apart
NORMAL_DIGITS = 3      # normal quantisation used to group coplanar triangles
AREA_EPS = 1e-6        # m2: overlaps / clipped pieces smaller than this are ignored
GRID = 1e-6            # m: snap-rounding grid for robust 2D boolean ops (1 micron)
LOCAL_ORIGIN_LIMIT = 1000.  # m: beyond this float32 loses sub-0.1 mm precision -> recentre
CREASE_COS = np.cos(np.radians(30))  # smooth normals across edges flatter than 30 degrees
META_TYPES = ('IfcElement', 'IfcSpace', 'IfcGrid', 'IfcAnnotation')
NOT_RENDERED = ('IfcFeatureElementSubtraction', 'IfcVirtualElement')
BODY_CONTEXTS = ['Body', 'Facetation']
AUX_REPRESENTATIONS = {'box', 'axis', 'footprint', 'annotation', 'profile', 'clearance', 'lighting', 'cog'}
SOLID_TYPES = {'sweptsolid', 'advancedsweptsolid', 'brep', 'advancedbrep', 'csg', 'clipping', 'solidmodel',
               'surfacemodel', 'tessellation', 'mappedrepresentation', 'surface3d', 'sectionedspine'}
# entity -> viewer category (see categoryNames in web/main.js)
ENTITY_CATEGORIES = [
    (('IfcWall', 'IfcCurtainWall'), 1),
    (('IfcSlab', 'IfcRoof'), 2),
    (('IfcBeam', 'IfcColumn', 'IfcMember'), 3),
    (('IfcDuctSegment', 'IfcDuctFitting', 'IfcAirTerminal'), 4),
    (('IfcPipeSegment', 'IfcPipeFitting'), 5),
    (('IfcCableCarrierSegment', 'IfcCableCarrierFitting', 'IfcCableSegment'), 6),
]


def text(v, limit=140):
    if v is None:
        return ''
    if isinstance(v, float):
        v = round(v, 6)
    return str(v)[:limit]


def _by_type(f, name):
    try:
        return f.by_type(name)
    except RuntimeError:              # entity not in this schema
        return []


def _is_any(p, types):
    for t in types:
        try:
            if p.is_a(t):
                return True
        except RuntimeError:          # entity not in this schema (e.g. IfcDuctSegment in IFC2X3)
            pass
    return False


def categorize(p, name, pset_names):
    if p.is_a('IfcSpace'):
        return 7
    for types, cat in ENTITY_CATEGORIES:
        if _is_any(p, types):
            return cat
    return classify(name, ';'.join(pset_names))


MEP_PSET_PREFIXES = ('Pset_Distribution', 'Pset_Duct', 'Pset_Pipe', 'Pset_Cable', 'Pset_FlowTerminal', 'Pset_AirTerminal',
                     'Pset_Pump', 'Pset_Fan', 'Pset_Valve', 'Pset_Damper', 'Pset_ElectricalDevice', 'Pset_LightFixture',
                     'Pset_SanitaryTerminal', 'Pset_Boiler', 'Pset_Chiller', 'Pset_Coil', 'Pset_UnitaryEquipment')
MEP_WORDS = ('duct', 'pipe', 'piping', 'cable', 'hvac', 'mechanical', 'plumbing', 'electrical', 'ventilation', 'sprinkler',
             'drainage', '通风', '风管', '管道', '桥架', '电缆', '暖通', '给排水', '喷淋', '机电', '空调', '电气')
CATEGORY_WORDS = ((4, ('duct', '通风', '风管', '空调')), (5, ('pipe', 'piping', '管道', '给排水', '喷淋')), (6, ('cable', '桥架', '电缆')))


def discipline_signals(f):
    """Element ids carrying standard IFC MEP semantics: system membership, distribution ports,
    classification text. Returns (in_system, with_port, classification_text)."""
    in_system, with_port, cls_text = set(), set(), collections.defaultdict(str)
    for r in f.by_type('IfcRelAssignsToGroup'):
        g = r.RelatingGroup
        if g.is_a('IfcSystem') and not _is_any(g, ('IfcZone', 'IfcBuildingSystem', 'IfcStructuralAnalysisModel')):
            in_system |= {o.id() for o in r.RelatedObjects}
    for r in _by_type(f, 'IfcRelNests'):
        if any(o.is_a('IfcPort') for o in r.RelatedObjects):
            with_port.add(r.RelatingObject.id())
    for r in _by_type(f, 'IfcRelConnectsPortToElement'):
        with_port.add(r.RelatedElement.id())
    for r in f.by_type('IfcRelAssociatesClassification'):
        c = r.RelatingClassification
        label = ' '.join(str(getattr(c, a, '') or '') for a in ('Identification', 'ItemReference', 'Name'))
        for o in r.RelatedObjects:
            cls_text[o.id()] += ' ' + label
    return in_system, with_port, cls_text


def discipline(p, category, pset_names, signals):
    """'MEP' or 'ARCH' plus the reason, from IFC semantics first and names last."""
    in_system, with_port, cls_text = signals
    if p.is_a('IfcSpace'):
        return 'ARCH', 'IfcSpace'
    if _is_any(p, ('IfcDistributionElement',)):
        return 'MEP', p.is_a()
    if p.id() in in_system:
        return 'MEP', 'IfcSystem'
    if p.id() in with_port:
        return 'MEP', 'IfcDistributionPort'
    hit = next((n for n in pset_names if n.startswith(MEP_PSET_PREFIXES)), None)
    if hit:
        return 'MEP', hit
    text = cls_text.get(p.id(), '').lower()
    if any(w in text for w in MEP_WORDS):
        return 'MEP', 'Classification:' + text.strip()[:40]
    if category in (4, 5, 6):
        return 'MEP', 'name'
    return 'ARCH', 'default'


def collect_metadata(f, unit):
    storeys = sorted(f.by_type('IfcBuildingStorey'), key=lambda s: s.Elevation or 0)
    levels = [{'id': s.id(), 'name': s.Name or '', 'elevation': (s.Elevation or 0) * unit} for s in storeys]
    level_of = {s.id(): i + 1 for i, s in enumerate(storeys)}
    seen = set(); products = []
    for t in META_TYPES:
        for p in f.by_type(t):
            if p.id() not in seen:
                seen.add(p.id()); products.append(p)
    products.sort(key=lambda p: p.id())
    elements = []; signals = discipline_signals(f); layer_of = presentation_layers(f)
    for p in products:
        psets = uel.get_psets(p, psets_only=True, should_inherit=False)
        props = {}
        for pname, values in psets.items():
            kept = [(k, v) for k, v in values.items() if k != 'id' and v not in (None, '')][:24]
            props.update({f'{pname}.{k}': text(v) for k, v in kept[:18]})
        # walk containment / aggregation up to the storey
        host, level = p, 0
        for _ in range(8):
            host = uel.get_container(host) or uel.get_aggregate(host)
            if host is None:
                break
            if host.id() in level_of:
                level = level_of[host.id()]; break
        name = (getattr(p, 'LongName', None) if p.is_a('IfcSpace') else None) or p.Name or f'{p.is_a().upper()} #{p.id()}'
        pset_names = list(psets)
        category = categorize(p, name, pset_names)
        disc, reason = discipline(p, category, pset_names, signals)
        if disc == 'MEP' and category == 0:    # refine untyped MEP proxies from classification text
            label = (signals[2].get(p.id(), '') + ' ' + name).lower()
            category = next((c for c, words in CATEGORY_WORDS if any(w in label for w in words)), 0)
        elements.append({
            'id': p.id(), 'guid': p.GlobalId, 'name': name, 'type': p.is_a().upper(),
            'category': category, 'discipline': disc, 'disciplineReason': reason,
            'psets': pset_names[:16], 'properties': props, 'level': level, 'bbox': None,
            'geometry': bool(p.Representation), 'tag': getattr(p, 'Tag', None) or '',
            'layer': product_layer(p, layer_of),
        })
    return elements, levels


def presentation_layers(f):
    """IfcPresentationLayerAssignment (CAD layer, e.g. Archicad layers): id of representation / item -> layer name."""
    out = {}
    for a in _by_type(f, 'IfcPresentationLayerAssignment'):
        for it in a.AssignedItems or []:
            out.setdefault(it.id(), a.Name or '')
    return out


def product_layer(p, layer_of):
    """Layer of a product: its body representation, else any representation / representation item."""
    reps = list(p.Representation.Representations) if getattr(p, 'Representation', None) else []
    reps.sort(key=lambda r: r.RepresentationIdentifier != 'Body')
    for r in reps:
        if r.id() in layer_of: return layer_of[r.id()]
        for it in r.Items or []:
            if it.id() in layer_of: return layer_of[it.id()]
    return None


def _render_candidates(f, elements):
    """Products to mesh: has a representation, is not a subtraction/virtual feature,
    and is not an assembly whose parts are meshed themselves."""
    by_id = {e['id']: f.by_id(e['id']) for e in elements}
    decomposed = set()
    for rel in f.by_type('IfcRelAggregates'):
        parent = rel.RelatingObject
        if parent.is_a('IfcElement') and any(getattr(c, 'Representation', None) for c in rel.RelatedObjects):
            decomposed.add(parent.id())
    return [p for i, p in by_id.items()
            if p.Representation and i not in decomposed and not _is_any(p, NOT_RENDERED)]


def _has_solid_rep(p):
    for r in p.Representation.Representations:
        ident = (r.RepresentationIdentifier or '').lower()
        if ident not in AUX_REPRESENTATIONS and (r.RepresentationType or '').lower() in SOLID_TYPES:
            return True
    return False


class Materials:
    """Global material table built from IfcOpenShell styles and indexed face colours."""
    def __init__(self, f):
        self.items, self.index = [], {}
        self.style_name, self.metal = {}, set()
        for style in f.by_type('IfcSurfaceStyle'):
            for st in style.Styles or ():
                self.style_name[st.id()] = style.Name or ''
                if st.is_a('IfcSurfaceStyleRendering') and st.ReflectanceMethod == 'METAL':
                    self.metal.add(st.id())
        self.default = self.add('default', '默认', (.7, .7, .7), 1.)

    def add(self, key, name, rgb, opacity, roughness=.8, metalness=0.):
        if key not in self.index:
            self.index[key] = len(self.items)
            self.items.append({'name': name, 'color': [round(float(c), 4) for c in rgb],
                               'opacity': round(float(opacity), 3), 'roughness': roughness, 'metalness': metalness})
        return self.index[key]

    def from_kernel(self, m):
        sid = int(m.name.rsplit('-', 1)[1]) if m.name.rsplit('-', 1)[-1].isdigit() else None
        name = self.style_name.get(sid) or ('默认' if m.name == 'DefaultMaterial' else m.name)
        rgb = tuple(m.diffuse.components) if m.diffuse is not None else (.7, .7, .7)
        t = m.transparency
        opacity = 1. if t is None or t != t else 1. - t
        spec = m.specularity
        rough = .8 if spec is None or spec != spec or spec <= 0 else float(np.clip(np.sqrt(2 / (spec + 2)), .15, .95))
        return self.add(('k', m.name, tuple(np.round(rgb, 4)), round(opacity, 3)), name, rgb, opacity,
                        rough, .6 if sid in self.metal else 0.)

    def colour(self, rgb, opacity, base):
        hexa = ''.join(f'{int(round(c * 255)):02X}' for c in rgb)
        return self.add(('c', tuple(np.round(rgb, 4)), round(opacity, 3)), f'{base} #{hexa}' if base else f'#{hexa}', rgb, opacity)


class FaceColours:
    """IfcIndexedColourMap: per-face colours of IfcPolygonalFaceSet items. IfcOpenShell
    only applies the item style, so triangles are matched back to faces by their
    vertices (triangulation adds no new points to polygonal faces)."""
    def __init__(self, f, unit, materials):
        self.unit, self.mats = unit, materials
        self.maps = {cm.MappedTo.id(): cm for cm in _by_type(f, 'IfcIndexedColourMap')}  # IFC4+ only
        self.f = f; self.overridden = 0

    def applies(self, product):
        return bool(self.maps) and any(it.id() in self.maps for r in product.Representation.Representations for it in r.Items)

    def apply(self, product, T, item_ids, M):
        world = uplace.get_local_placement(product.ObjectPlacement)
        for item_id in set(item_ids.tolist()) & self.maps.keys():
            sel = np.flatnonzero(item_ids == item_id)
            item = self.f.by_id(item_id); cmap = self.maps[item_id]
            pts = np.asarray(item.Coordinates.CoordList, float)
            if getattr(item, 'PnIndex', None):
                pts = pts[np.asarray(item.PnIndex) - 1]
            pts = (pts @ world[:3, :3].T + world[:3, 3]) * self.unit
            faces_of = collections.defaultdict(set)
            for k, face in enumerate(item.Faces):
                ids = list(face.CoordIndex)
                for inner in getattr(face, 'InnerCoordIndices', None) or ():
                    ids += list(inner)
                for i in ids:
                    faces_of[i - 1].add(k)
            V = T[sel].reshape(-1, 3); nearest = np.empty(len(V), int); dist = np.empty(len(V))
            for a in range(0, len(V), 1024):
                d2 = ((V[a:a + 1024, None, :] - pts[None]) ** 2).sum(-1)
                nearest[a:a + 1024] = d2.argmin(1); dist[a:a + 1024] = d2.min(1)
            if dist.max() > 1e-6:           # mapped item / unexpected transform: keep style colour
                continue
            base = next((st.Name for si in self.f.get_inverse(item) if si.is_a('IfcStyledItem')
                         for st in si.Styles if st.is_a('IfcSurfaceStyle') and st.Name), '')
            colours, index = cmap.Colours.ColourList, cmap.ColourIndex
            opacity = cmap.Opacity if cmap.Opacity is not None else 1.
            face_mat = {}
            for t, (a, b, c) in zip(sel, nearest.reshape(-1, 3)):
                cand = faces_of[a] & faces_of[b] & faces_of[c]
                if not cand:
                    continue
                k = min(cand)
                if k >= len(index):
                    continue
                if k not in face_mat:
                    face_mat[k] = self.mats.colour(colours[index[k] - 1], opacity, base)
                M[t] = face_mat[k]; self.overridden += 1


def _iterate(f, products, identifiers, meshes, index_of, materials, colours, progress):
    if not products:
        return
    settings = ifcopenshell.geom.settings()
    settings.set('use-world-coords', True)
    settings.set('weld-vertices', True)
    if identifiers:
        settings.set('context-identifiers', identifiers)
    it = ifcopenshell.geom.iterator(settings, f, multiprocessing.cpu_count(), include=products)
    if not it.initialize():
        return
    kernel_mats = {}
    while True:
        shape = it.get()
        i = index_of.get(shape.id)
        g = shape.geometry
        F = np.asarray(g.faces, dtype=np.int64).reshape(-1, 3)
        if i is not None and len(F):
            V = np.asarray(g.verts, dtype=np.float64).reshape(-1, 3)
            T = V[F]                      # (n,3,3) world-space triangles, Z-up metres
            lut = []
            for m in g.materials:
                key = (m.name, tuple(m.diffuse.components) if m.diffuse is not None else None, m.transparency)
                if key not in kernel_mats:
                    kernel_mats[key] = materials.from_kernel(m)
                lut.append(kernel_mats[key])
            lut = np.asarray(lut + [materials.default], np.int64)
            mids = np.asarray(g.material_ids, np.int64)
            M = lut[np.where(mids < 0, len(lut) - 1, mids)] if len(mids) == len(F) else np.full(len(F), materials.default)
            product = f.by_id(shape.id)
            if colours.applies(product):
                colours.apply(product, T, np.asarray(g.item_ids), M)
            meshes[i] = (T, M)
            if len(meshes) % 1000 == 0:
                progress(f'Tessellated {len(meshes)} elements')
        if not it.next():
            break


def tessellate(f, elements, unit, progress):
    index_of = {e['id']: i for i, e in enumerate(elements)}
    products = _render_candidates(f, elements)
    materials = Materials(f); colours = FaceColours(f, unit, materials)
    meshes = {}
    _iterate(f, products, BODY_CONTEXTS, meshes, index_of, materials, colours, progress)
    # Exporters that put the body in an unnamed / differently named 3D context
    missing = [p for p in products if index_of[p.id()] not in meshes and _has_solid_rep(p)]
    if missing:
        progress(f'{len(missing)} elements without Body context geometry; retrying all 3D contexts')
        _iterate(f, missing, None, meshes, index_of, materials, colours, progress)
    failed = sum(1 for p in products if index_of[p.id()] not in meshes and _has_solid_rep(p))
    return meshes, failed, materials, colours.overridden


def _areal(g):
    """Keep only the polygonal part of an overlay result (snap rounding may emit lines/points)."""
    if g.geom_type in ('Polygon', 'MultiPolygon'):
        return g
    parts = [p for p in getattr(g, 'geoms', []) if p.geom_type in ('Polygon', 'MultiPolygon')]
    return shapely.union_all(parts, grid_size=GRID) if parts else Polygon()


def _op(fn, a, b):
    return _areal(fn(_areal(a), _areal(b), grid_size=GRID))


def _overlap_areas(a, b):
    """Vectorised intersection areas; falls back per pair if GEOS rejects a degenerate input."""
    try:
        return shapely.area(shapely.intersection(a, b, grid_size=GRID))
    except shapely.errors.GEOSException:
        return np.array([_op(shapely.intersection, x, y).area for x, y in zip(a, b)])


def _cross3(a, b):   # np.cross has heavy per-call overhead on single vectors
    return np.array([a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]])


def _basis(n):
    u = _cross3(n, (0., 0., 1.) if abs(n[2]) < .9 else (1., 0., 0.))
    u /= np.linalg.norm(u)
    return u, _cross3(n, u)


def _lift(poly, u, v, nc, n_t, d_t):
    """Triangulate a 2D (multi)polygon and lift it back onto the triangle's own plane."""
    out = []
    for tri in shapely.constrained_delaunay_triangles(poly).geoms:
        if tri.area < AREA_EPS * .01:
            continue
        xy = np.asarray(tri.exterior.coords)[:3]
        base = xy[:, :1] * u + xy[:, 1:2] * v
        w = (d_t - base @ n_t) / (nc @ n_t)
        P = base + w[:, None] * nc
        if _cross3(P[1] - P[0], P[2] - P[0]) @ n_t < 0:
            P = P[[0, 2, 1]]
        out.append(P)
    return out


def _resolve_cluster(idx, T, M, n, d, owner, elements, dups, stats, touched, out_keep):
    nc = n[idx[0]]; u, v = _basis(nc)
    xy = np.stack([T[idx] @ u, T[idx] @ v], -1)            # (k,3,2)
    own = owner[idx]
    # cheap reject: no two elements' 2D boxes overlap and no element has more than one face pair
    els, inv = np.unique(own, return_inverse=True)
    if len(els) > 1:
        lo = np.full((len(els), 2), np.inf); hi = np.full((len(els), 2), -np.inf)
        np.minimum.at(lo, inv, xy.min(1)); np.maximum.at(hi, inv, xy.max(1))
        ov = (np.minimum(hi[:, None], hi[None]) - np.maximum(lo[:, None], lo[None])).clip(0).prod(-1)
        np.fill_diagonal(ov, 0)
        cross_possible = (ov > AREA_EPS).any()
    else:
        cross_possible = False
    if not cross_possible and np.bincount(inv).max() <= 2:
        return
    polys = shapely.polygons(xy)
    ok = shapely.area(polys) > AREA_EPS * .01               # degenerate slivers are left untouched
    # candidate pairs via spatial index, exact overlap area vectorised
    a, b = shapely.STRtree(polys).query(polys, predicate='intersects')
    m = (a < b) & ok[a] & ok[b]
    a, b = a[m], b[m]
    if len(a):                                             # drop neighbours that only share an edge
        m = ~shapely.touches(polys[a], polys[b]); a, b = a[m], b[m]
    if not len(a):
        return
    ar = _overlap_areas(polys[a], polys[b])
    m = ar > AREA_EPS
    a, b = a[m], b[m]
    if not len(a):
        return
    # Front-most face wins: rank by plane offset along the normal (larger = closer to a
    # viewer on the visible side), ties by STEP id then triangle order.
    rank = np.empty(len(idx), np.int64)
    rank[sorted(range(len(idx)), key=lambda k: (-round(d[idx[k]], 5), elements[own[k]]['id'], k))] = np.arange(len(idx))
    front = np.where(rank[a] < rank[b], a, b); back = np.where(rank[a] < rank[b], b, a)
    fronts_of = collections.defaultdict(list)
    for fr, bk in zip(front, back):
        fronts_of[bk].append(fr)
    for k, frs in fronts_of.items():
        t = idx[k]; el = own[k]; poly = polys[k]; rest = poly
        by_el = collections.defaultdict(list)
        for fr in frs:
            by_el[own[fr]].append(fr)
        for c in sorted(by_el, key=lambda c: elements[c]['id']):
            if c == el or rest.is_empty:
                continue
            U = _areal(shapely.union_all(polys[by_el[c]], grid_size=GRID))
            piece = _op(shapely.intersection, rest, U)
            if piece.area > AREA_EPS:
                dups[(el, c)] += [(P, M[t]) for P in _lift(piece, u, v, nc, n[t], d[t])]
                rest = _op(shapely.difference, rest, U)
                stats['area'] += piece.area; stats['pairs'].add((el, c))
        if el in by_el and not rest.is_empty:          # hidden behind the element's own front face
            U = _areal(shapely.union_all(polys[by_el[el]], grid_size=GRID))
            ov_self = _op(shapely.intersection, rest, U).area
            if ov_self > AREA_EPS:
                rest = _op(shapely.difference, rest, U); stats['selfArea'] += ov_self
        if rest.area < poly.area - AREA_EPS:
            touched[t] = True
            if rest.area > AREA_EPS:
                out_keep[el] += [(P, M[t]) for P in _lift(rest, u, v, nc, n[t], d[t])]


def _resolve_pass(current, elements, shift, dups, stats):
    """One clustering pass. Faces are binned by quantised normal and by plane offset
    on a PLANE_BIN grid; `shift` (0 or .5) offsets both grids by half a cell so that
    faces straddling a bin edge in one pass share a bin in the other."""
    ids = list(current)
    owner = np.concatenate([np.full(len(current[i][0]), i) for i in ids])
    T = np.concatenate([current[i][0] for i in ids]); M = np.concatenate([current[i][1] for i in ids])
    n = np.cross(T[:, 1] - T[:, 0], T[:, 2] - T[:, 0]); area2 = np.linalg.norm(n, axis=1)
    valid = area2 > 1e-12
    n[valid] /= area2[valid, None]
    d = np.einsum('ij,ij->i', n, T[:, 0])
    keys = np.column_stack([np.floor(n * 10 ** NORMAL_DIGITS + shift), np.floor(d / PLANE_BIN + shift)]).astype(np.int64)
    sel = np.flatnonzero(valid); keys = keys[sel]
    srt = np.lexsort(keys.T[::-1]); order = sel[srt]; ks = keys[srt]
    brk = np.r_[True, (np.diff(ks, axis=0) != 0).any(1)]
    starts = np.flatnonzero(brk); ends = np.r_[starts[1:], len(order)]
    touched = np.zeros(len(T), bool); out_keep = collections.defaultdict(list)
    for s, e in zip(starts, ends):
        if e - s >= 2:
            _resolve_cluster(order[s:e], T, M, n, d, owner, elements, dups, stats, touched, out_keep)
    result = {}
    for i in ids:
        sel = (owner == i) & ~touched
        Ti, Mi = T[sel], M[sel]
        if out_keep.get(i):
            Ti = np.concatenate([Ti, np.asarray([P for P, _ in out_keep[i]])])
            Mi = np.concatenate([Mi, np.asarray([m for _, m in out_keep[i]], Mi.dtype)])
        result[i] = (Ti, Mi)
    return result


def resolve_coplanar(meshes, elements):
    """Cut same-facing coplanar overlaps. Returns (kept, dups, stats).

    meshes / kept: {elem: (T (n,3,3), material (n,))};
    dups: {(owner, cover): (T, material)} pieces of `owner` hidden by `cover`.
    """
    # IfcSpace volumes are overlays, leave untouched
    # sorted: the iterator returns shapes in thread order; a fixed order keeps the output deterministic
    current = {i: meshes[i] for i in sorted(meshes) if elements[i]['category'] != 7}
    dups = collections.defaultdict(list); stats = {'pairs': set(), 'area': 0., 'selfArea': 0.}
    if current:
        for shift in (0., .5):
            current = _resolve_pass(current, elements, shift, dups, stats)
    kept = {**{i: m for i, m in meshes.items() if elements[i]['category'] == 7}, **current}
    dups = {k: (np.asarray([P for P, _ in v]), np.asarray([m for _, m in v], np.int64)) for k, v in dups.items() if v}
    return kept, dups, {'pairs': len(stats['pairs']), 'area': round(stats['area'], 2), 'selfArea': round(stats['selfArea'], 2)}


def local_origin(meshes):
    """Horizontal shift that keeps float32 vertices precise for georeferenced models."""
    lo = np.min([T.reshape(-1, 3).min(0) for T, _ in meshes.values()], 0)
    hi = np.max([T.reshape(-1, 3).max(0) for T, _ in meshes.values()], 0)
    if max(abs(lo[0]), abs(lo[1]), abs(hi[0]), abs(hi[1])) <= LOCAL_ORIGIN_LIMIT:
        return np.zeros(3)
    return np.array([round((lo[0] + hi[0]) / 2), round((lo[1] + hi[1]) / 2), 0.])


def crease_normals(T):
    """Per-corner normals: average of area-weighted face normals sharing a position,
    falling back to the flat face normal across edges sharper than 30 degrees."""
    raw = np.cross(T[:, 1] - T[:, 0], T[:, 2] - T[:, 0])
    flat = raw / np.maximum(np.linalg.norm(raw, axis=1, keepdims=True), 1e-20)
    _, group = np.unique(np.round(T.reshape(-1, 3), 5), axis=0, return_inverse=True)
    group = group.ravel()
    acc = np.zeros((group.max() + 1, 3))
    np.add.at(acc, group, np.repeat(raw, 3, axis=0))
    smooth = acc[group]; smooth /= np.maximum(np.linalg.norm(smooth, axis=1, keepdims=True), 1e-20)
    corner_flat = np.repeat(flat, 3, axis=0)
    use_flat = (smooth * corner_flat).sum(1) < CREASE_COS
    smooth[use_flat] = corner_flat[use_flat]
    return smooth.reshape(-1, 3, 3)


def write_geometry(outdir, parts, materials):
    """parts: [(T, material, element, cover)] -> planar V2 buffers, opaque first."""
    opacity = np.array([m['opacity'] for m in materials.items])
    chunks = {k: [] for k in ('position', 'normal', 'element', 'cover', 'material')}
    counts = [0, 0]
    for transparent in (False, True):
        for T, M, el, cover in parts:
            sel = (opacity[M] < .999) == transparent
            if not sel.any():
                continue
            Ts, Ms = T[sel], M[sel]
            N = crease_normals(Ts).reshape(-1, 3); P = Ts.reshape(-1, 3)
            chunks['position'].append(np.stack([P[:, 0], P[:, 2], -P[:, 1]], 1).astype('<f4'))  # Z-up -> Y-up
            n8 = np.zeros((len(N), 4), np.int8)
            n8[:, :3] = np.round(np.stack([N[:, 0], N[:, 2], -N[:, 1]], 1) * 127)
            chunks['normal'].append(n8)
            chunks['element'].append(np.full(len(P), el, '<u4'))
            chunks['cover'].append(np.full(len(P), cover, '<u4'))
            chunks['material'].append(np.repeat(Ms, 3).astype('<u2'))
            counts[transparent] += len(P)
    layout = {'vertices': sum(counts), 'opaqueVertices': counts[0]}
    offset = 0
    with open(outdir / 'model.bin', 'wb') as fh:
        for key, dtype, size in (('position', 'f32', 3), ('normal', 'i8', 4), ('element', 'u32', 1),
                                 ('cover', 'u32', 1), ('material', 'u16', 1)):
            blob = np.concatenate(chunks[key]).tobytes()
            blob += b'\0' * (-len(blob) % 4)
            fh.write(blob); layout[key] = [offset, dtype, size]; offset += len(blob)
    return layout


def convert(path, outdir, progress=print):
    started = time.time(); outdir = Path(outdir); outdir.mkdir(parents=True, exist_ok=True)
    f = ifcopenshell.open(str(path))
    unit = uunit.calculate_unit_scale(f)
    progress(f'Opened {f.schema} with IfcOpenShell {ifcopenshell.version}: {len(list(f))} entities')
    elements, levels = collect_metadata(f, unit)
    meshes, failed, materials, recoloured = tessellate(f, elements, unit, progress)
    if not meshes:
        raise ValueError('IfcOpenShell produced no 3D body geometry for this IFC file')
    if len(materials.items) > 0xffff:
        raise ValueError(f'{len(materials.items)} materials exceed the 16-bit material index')
    origin = local_origin(meshes)
    if origin.any():
        progress(f'Georeferenced coordinates: shifting by {origin[:2].tolist()} m for float32 precision')
        meshes = {i: (T - origin, M) for i, (T, M) in meshes.items()}
    progress(f'Tessellated {len(meshes)} elements, {len(materials.items)} materials, '
             f'{recoloured} face-colour triangles in {time.time() - started:.1f}s; resolving coplanar overlaps')
    kept, dups, overlap = resolve_coplanar(meshes, elements)
    # canonical material order (the kernel returns shapes in thread order): default first, then by name/colour
    items = materials.items
    order = [0] + sorted(range(1, len(items)), key=lambda k: (items[k]['name'], items[k]['color'], items[k]['opacity']))
    remap = np.empty(len(items), np.int64); remap[order] = np.arange(len(items))
    materials.items = [items[k] for k in order]
    kept = {i: (T, remap[M]) for i, (T, M) in kept.items()}
    dups = {k: (T, remap[M]) for k, (T, M) in dups.items()}
    progress(f'Coplanar overlaps: {overlap} ({time.time() - started:.1f}s)')
    dup_parts = collections.defaultdict(list)
    for (owner, _), (T, _) in dups.items():
        dup_parts[owner].append(T)
    for i, el in enumerate(elements):
        # an element entirely duplicated by another one has only duplicate pieces
        T = kept[i][0] if i in kept else None
        parts = [x for x in [T, *dup_parts.get(i, [])] if x is not None and len(x)]
        if not parts:
            el['geometry'] = False
            continue
        el['triangles'] = 0 if T is None else len(T)
        P = np.concatenate(parts).reshape(-1, 3)
        lo, hi = P.min(0), P.max(0)
        el['bbox'] = [round(float(x), 4) for x in (lo[0], lo[2], -hi[1], hi[0], hi[2], -lo[1])]  # Y-up
        used = collections.Counter(np.concatenate([kept[i][1]] if i in kept else [np.zeros(0, int)]).tolist())
        el['styles'] = [materials.items[m]['name'] for m, _ in used.most_common(6)]
        mat = uel.get_material(f.by_id(el['id']), should_skip_usage=True)
        if mat is not None:
            el['materials'] = sorted({getattr(m, 'Name', None) or '' for m in _material_leaves(mat)} - {''})[:8]
    for i, el in enumerate(elements):
        if el['category'] == 7 and i in kept and len(kept[i][0]):
            el['viewpoint'] = room_viewpoint(kept[i][0])
    # fill missing floors from the nearest storey elevation (Y-up bbox centre)
    for el in elements:
        if el['level'] == 0 and el['bbox'] and levels:
            y = (el['bbox'][1] + el['bbox'][4]) * .5
            el['level'] = min(range(len(levels)), key=lambda k: abs(y - levels[k]['elevation'])) + 1
    boxes = np.array([el['bbox'] for el in elements if el['bbox']])
    bounds = np.r_[boxes[:, :3].min(0), boxes[:, 3:].max(0)]
    parts = [(T, M, i, 0) for i, (T, M) in sorted(kept.items()) if len(T)]
    parts += [(T, M, owner, cover + 1) for (owner, cover), (T, M) in sorted(dups.items())]
    layout = write_geometry(outdir, parts, materials)
    types = collections.Counter(e.is_a().upper() for e in f)
    stats = {
        'entities': len(list(f)), 'ifcTypes': dict(types), 'products': len(elements),
        'geometricProducts': sum(bool(e['bbox']) for e in elements),
        'triangles': sum(e.get('triangles', 0) for e in elements), 'vertices': layout['vertices'],
        'unitScale': unit, 'droppedGeometry': failed,
        'materials': len(materials.items), 'faceColourTriangles': recoloured,
        'classified': dict(collections.Counter(e['category'] for e in elements if e['bbox'])),
        'ifcSystems': types['IFCSYSTEM'] + types['IFCDISTRIBUTIONSYSTEM'] + types['IFCBUILDINGSYSTEM'],
        'ports': types['IFCDISTRIBUTIONPORT'], 'portConnections': types['IFCRELCONNECTSPORTS'],
        'coplanarOverlap': {**overlap, 'binWidth': PLANE_BIN},
        'geometryKernel': f'IfcOpenShell {ifcopenshell.version}',
        'classificationNote': 'Typed IFC entities are categorised by class; proxies by name / Pset heuristics that must be reviewed.',
    }
    manifest = {'format': 'WEA_WEBGL_V2', 'name': Path(path).stem, 'schema': f.schema,
                'generator': f'WEA IfcOpenShell converter ({ifcopenshell.version})',
                'origin': [float(x) for x in origin],  # IFC world XYZ (Z-up, m) of the local origin
                'elements': elements, 'levels': levels, 'bounds': [round(float(x), 4) for x in bounds],
                'rooms': [e['id'] for e in elements if e['category'] == 7], 'materials': materials.items,
                'layout': layout, 'stats': stats, 'binary': 'model.bin'}
    (outdir / 'model.json').write_text(json.dumps(manifest, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    progress(f'Saved {(outdir / "model.bin").stat().st_size // 1024} KiB binary + manifest in {time.time() - started:.1f}s')
    from room_context import write_rooms, site_info, grid_axes  # lighting work areas + grid axes, separate file
    write_rooms(outdir, project=next(({'guid': p.GlobalId, 'name': p.Name or ''} for p in f.by_type('IfcProject')), None), site=site_info(f),
                grids=grid_axes(f, [float(x) for x in origin]))
    return stats


EYE_HEIGHT = 1.6   # m above the room floor


def room_viewpoint(T):
    """Eye-level viewpoint inside a space, composed like an interior photo: start at the
    footprint's pole of inaccessibility (shapely polylabel - stays inside L/U shaped rooms
    where the bbox centre would not), find the farthest corner, then back away from it
    until 0.5 m from the walls, looking across the room at that corner."""
    footprint = _areal(shapely.union_all(shapely.polygons(T[:, :, :2]), grid_size=1e-4))
    if footprint.is_empty:
        return None
    if footprint.geom_type == 'MultiPolygon':
        footprint = max(footprint.geoms, key=lambda g: g.area)
    from shapely.ops import polylabel
    c = polylabel(footprint, tolerance=.02)
    ring = np.asarray(footprint.exterior.coords)
    far = ring[np.argmax(((ring - (c.x, c.y)) ** 2).sum(1))]
    back = np.array([c.x, c.y]) - far; back /= max(np.linalg.norm(back), 1e-9)
    inner = footprint.buffer(-.5)
    eye_xy = np.array([c.x, c.y])
    for t in np.arange(.1, 30, .1):                  # walk back while staying 0.5 m inside
        q = np.array([c.x, c.y]) + back * t
        if inner.is_empty or not inner.contains(shapely.Point(q)):
            break
        eye_xy = q
    floor = float(T[:, :, 2].min())
    eye = (eye_xy[0], eye_xy[1], floor + EYE_HEIGHT); look = (far[0], far[1], floor + EYE_HEIGHT)
    yup = lambda q: [round(float(q[0]), 3), round(float(q[2]), 3), round(float(-q[1]), 3)]  # Z-up -> Y-up
    return {'eye': yup(eye), 'look': yup(look), 'floor': round(floor, 3)}


CEILING_MIN = 1.8        # m above room floor: lower down-facing surfaces are furniture / sills, not ceilings
CEILING_SAMPLE = .25     # m grid used to probe the ceiling over the room footprint


def ceiling_candidates(kept, elements):
    """Down-facing triangles of architectural (non-space, non-MEP) elements: potential ceiling
    soffits. Returns (T (n,3,3) local Z-up m, owner element index (n,))."""
    tris, owners = [], []
    for i, (T, _) in kept.items():
        el = elements[i]
        if el['category'] == 7 or el.get('discipline') == 'MEP' or not len(T):
            continue
        n = np.cross(T[:, 1] - T[:, 0], T[:, 2] - T[:, 0])
        down = n[:, 2] < -.7 * np.linalg.norm(n, axis=1)
        if down.any():
            tris.append(T[down]); owners.append(np.full(down.sum(), i))
    if not tris:
        return np.zeros((0, 3, 3)), np.zeros(0, int)
    return np.concatenate(tris), np.concatenate(owners)


def room_context(T, candidates, elements):
    """Lighting work area of an IfcSpace (local IFC coords, Z-up, metres):
    footprint polygon, floor level, space top, and the *measured* ceiling: lowest
    down-facing architectural surface above each 0.25 m sample point of the footprint.
    Coverage < 60 % or an implausible height is flagged for manual confirmation
    instead of being guessed."""
    footprint = _areal(shapely.union_all(shapely.polygons(T[:, :, :2]), grid_size=1e-4))
    if footprint.is_empty:
        return None
    parts = list(footprint.geoms) if footprint.geom_type == 'MultiPolygon' else [footprint]
    main = max(parts, key=lambda g: g.area).simplify(.005)
    floor, top = float(T[:, :, 2].min()), float(T[:, :, 2].max())
    x0, y0, x1, y1 = main.bounds
    gx, gy = np.meshgrid(np.arange(x0 + CEILING_SAMPLE / 2, x1, CEILING_SAMPLE), np.arange(y0 + CEILING_SAMPLE / 2, y1, CEILING_SAMPLE))
    pts = np.column_stack([gx.ravel(), gy.ravel()])
    pts = pts[shapely.contains_xy(main, pts[:, 0], pts[:, 1])]
    C, owner = candidates
    hit_z = np.full(len(pts), np.inf); hit_el = np.full(len(pts), -1)
    if len(C) and len(pts):
        zc = C[:, :, 2].mean(1)
        sel = (zc > floor + CEILING_MIN) & (zc < top + 1.0) & (C[:, :, 0].max(1) >= x0) & (C[:, :, 0].min(1) <= x1) \
            & (C[:, :, 1].max(1) >= y0) & (C[:, :, 1].min(1) <= y1)
        Cs, Os = C[sel], owner[sel]
        for a in range(0, len(Cs), 512):                      # barycentric point-in-triangle, chunked
            tri = Cs[a:a + 512]; A, B, D = tri[:, 0], tri[:, 1], tri[:, 2]
            v0, v1 = (D - A)[:, :2], (B - A)[:, :2]
            v2 = pts[None, :, :] - A[:, None, :2]
            d00, d01, d11 = (v0 * v0).sum(1), (v0 * v1).sum(1), (v1 * v1).sum(1)
            d20, d21 = (v2 * v0[:, None]).sum(2), (v2 * v1[:, None]).sum(2)
            den = d00 * d11 - d01 * d01
            ok = np.abs(den) > 1e-12
            u = np.where(ok[:, None], (d11[:, None] * d20 - d01[:, None] * d21) / np.where(ok, den, 1)[:, None], -1)
            v = np.where(ok[:, None], (d00[:, None] * d21 - d01[:, None] * d20) / np.where(ok, den, 1)[:, None], -1)
            inside = (u >= -1e-6) & (v >= -1e-6) & (u + v <= 1 + 1e-6)
            z = A[:, None, 2] + u * (D - A)[:, None, 2] + v * (B - A)[:, None, 2]
            z = np.where(inside, z, np.inf)
            k = z.argmin(0); zmin = z[k, np.arange(len(pts))]
            better = zmin < hit_z
            hit_z[better] = zmin[better]; hit_el[better] = Os[a:a + 512][k[better]]
    found = np.isfinite(hit_z)
    levels = []
    if found.any():
        zs = np.round(hit_z[found], 2)
        for z, n in collections.Counter(zs.tolist()).most_common(4):
            ids = collections.Counter(hit_el[found][zs == z].tolist()).most_common(3)
            levels.append({'z': round(z, 3), 'height': round(z - floor, 3), 'coverage': round(n / len(pts), 3),
                           'elements': [{'id': elements[e]['id'], 'guid': elements[e]['guid'], 'name': elements[e]['name']} for e, _ in ids]})
    coverage = float(found.mean()) if len(pts) else 0.
    issues = []
    if coverage < .6:
        issues.append(f'天花探测覆盖率仅 {coverage:.0%}')
    if levels and not (2.0 <= levels[0]['height'] <= 6.0):
        issues.append(f'主天花高度 {levels[0]["height"]:.2f} m 不在常见范围')
    if top - floor < 2.0:
        issues.append('IfcSpace 高度不足 2 m')
    if main.area < .3 * sum(g.area for g in parts) or len(parts) > 1:
        issues.append('IfcSpace 平面由多块组成')
    return {'footprint': [[round(x, 4), round(y, 4)] for x, y in np.asarray(main.exterior.coords)[:-1]],
            'holes': [[[round(x, 4), round(y, 4)] for x, y in np.asarray(r.coords)[:-1]] for r in main.interiors],
            'area': round(main.area, 3), 'floor': round(floor, 3), 'top': round(top, 3),
            'ceilings': levels, 'ceilingCoverage': round(coverage, 3), 'samples': int(len(pts)),
            'needsConfirmation': bool(issues), 'issues': issues, 'source': 'IfcSpace geometry'}


def _material_leaves(mat):
    """Flatten IfcMaterial / layer set / profile set / constituent set / list to IfcMaterial entities."""
    if mat.is_a('IfcMaterial'):
        return [mat]
    out = []
    for attr in ('Materials', 'MaterialLayers', 'MaterialProfiles', 'MaterialConstituents'):
        for x in getattr(mat, attr, None) or ():
            out += _material_leaves(x)
    for attr in ('Material', 'ForLayerSet', 'ForProfileSet'):
        x = getattr(mat, attr, None)
        if x is not None and x is not mat:
            out += _material_leaves(x)
    return out


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print('Usage: .venv/bin/python tools/ifc_convert_ios.py INPUT.ifc assets/'); sys.exit(2)
    print(json.dumps(convert(sys.argv[1], sys.argv[2]), ensure_ascii=False, indent=2)[:1600])
