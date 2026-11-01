#!/usr/bin/env python3
"""WEA Lighting — ELV drawings: lighting control (protocol-neutral) and low-voltage fixture supply -> DXF.

Input: the lighting design (web/lighting, schemaVersion 1) plus the converted model (assets/), read-only.
Output (millimetres, IFC world coordinates so the plans overlay the Archicad plan):
  01 照明控制平面图   plan cut of the building at +1.2 m, fixtures, control groups, control panels, control links
  02 低压供电平面图   LV fixtures, drivers (placed at the nearest ceiling access hatch), LV runs, cable size, voltage drop
  03 系统图及表格     per-room control logic, device list, group table, default scenes, driver / voltage-drop table
  04 照明配电平面图   220 V lighting circuits (tools/mains_circuits.py): distribution board AL1, circuits WL1…,
                     home runs, fixture connections, switch legs, circuit labels (导线-保护管-敷设)
  05 照明配电系统图   single-line diagram of AL1 and the circuit / load / voltage-drop table

Design rules (defaults; all parameters editable in `settings` and reported in the drawings):
  * control groups: per room by fixture type, unless the fixture sets electrical.group
  * control panel: wall beside the room's door (door found by bbox within 0.6 m of the room boundary),
    1.3 m above floor; no door found -> placed at the boundary and flagged for manual confirmation
  * LV supply: linear fixtures 24 V constant-voltage by default (fixture electrical.supply overrides);
    driver rating = load x 1.2 rounded up to a standard size; driver at the nearest access hatch of the room
  * voltage drop: dU = 2 * L * I * rho / A (copper rho = 0.0175 ohm mm2/m), L = orthogonal route length,
    smallest cross-section meeting the limit (default 3 %) is chosen
The control protocol is not fixed yet: the drawings show logical control links and groups, no bus
addresses. Everything is a design draft for review by the responsible electrical engineer.
"""
import io, json, math, zipfile, datetime
from pathlib import Path

import numpy as np
import ezdxf
from ezdxf.enums import TextEntityAlignment

import radiance_sim                      # shared, cached model loader (read-only)
import mains_circuits                    # 220 V lighting circuits

RHO_CU = 0.0175                          # ohm mm2 / m
DRIVER_SIZES = [30, 60, 100, 150, 200, 240, 320]
CABLE_SIZES = [0.75, 1.0, 1.5, 2.5, 4.0]
DEFAULTS = {'lvVoltage': 24, 'dropLimit': 3.0, 'driverMargin': 1.2, 'panelHeight': 1.3, 'planCut': 1.2}
TYPE_LABEL = {'downlight': '筒灯', 'spotlight': '射灯', 'linear': '线性灯', 'pendant': '吊灯', 'ceiling': '吸顶灯', 'luminous': '发光体'}
LAYERS = {'A-WALL': 8, 'E-FIXT': 2, 'E-CTRL-DEV': 1, 'E-CTRL-LINK': 4, 'E-LV-DRV': 6, 'E-LV-WIRE': 30,
          'E-TEXT': 7, 'E-TABLE': 7, 'E-TITLE': 7, 'E-ROOM': 9, 'E-LEGEND': 7, 'E-PWR': 1, 'E-PWR-SW': 3, 'E-PWR-BOARD': 1}
CIRCUIT_COLORS = [1, 3, 4, 6, 30, 150, 210, 50, 110, 230]       # readable on white and dark backgrounds (no pure blue)


# ---------------------------------------------------------------- geometry helpers
def plan_cut(data, z, region):
    """Horizontal section of architectural geometry at height z (IFC local) -> list of 2D segments."""
    T, el = data['T'], data['el']; els = data['model']['elements']
    keep = np.array([e['category'] != 7 and e.get('discipline') != 'MEP' for e in els])
    opac = np.array([m['opacity'] for m in data['model']['materials']])
    lo, hi = region
    sel = keep[el] & (data['cover'] == 0) & (opac[data['mat']] >= 0.02)
    zs = T[:, :, 2]
    sel &= (zs.min(1) < z) & (zs.max(1) > z)
    sel &= (T[:, :, 0].max(1) > lo[0]) & (T[:, :, 0].min(1) < hi[0]) & (T[:, :, 1].max(1) > lo[1]) & (T[:, :, 1].min(1) < hi[1])
    segs = []
    for t in T[sel]:
        pts = []
        for a, b in ((0, 1), (1, 2), (2, 0)):
            za, zb = t[a, 2] - z, t[b, 2] - z
            if (za < 0) != (zb < 0):
                s = za / (za - zb); pts.append(t[a, :2] + s * (t[b, :2] - t[a, :2]))
        if len(pts) == 2 and np.linalg.norm(pts[0] - pts[1]) > 1e-3:
            segs.append((pts[0], pts[1]))
    return segs


def nearest_on_ring(p, ring):
    best = None
    for i in range(len(ring)):
        a, b = np.asarray(ring[i], float), np.asarray(ring[(i + 1) % len(ring)], float)
        d = b - a; L = d @ d
        t = 0 if L == 0 else max(0, min(1, (p - a) @ d / L))
        q = a + t * d; dist = np.linalg.norm(p - q)
        if best is None or dist < best[0]:
            best = (dist, q, d / math.sqrt(L) if L else np.array([1., 0.]), i)
    return best


def inside(pt, ring):
    x, y = pt; c = False
    for i in range(len(ring)):
        (x1, y1), (x2, y2) = ring[i], ring[i - 1]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            c = not c
    return c


def manhattan(a, b):
    """Orthogonal route a -> b (two legs) as polyline points; length in m."""
    mid = (b[0], a[1])
    return [tuple(a), mid, tuple(b)], abs(b[0] - a[0]) + abs(b[1] - a[1])


def chain(points):
    """Nearest-neighbour order starting at the first point (daisy-chained links)."""
    left = list(range(1, len(points))); order = [0]
    while left:
        last = points[order[-1]]
        k = min(left, key=lambda i: (points[i][0] - last[0]) ** 2 + (points[i][1] - last[1]) ** 2)
        order.append(k); left.remove(k)
    return order


def local_bbox(e):
    b = e['bbox']                                   # view (Y-up) -> IFC local
    return np.array([b[0], -b[5], b[1]]), np.array([b[3], -b[2], b[4]])


# ---------------------------------------------------------------- design analysis
def seg_distance(pts, S):
    """Distance from each point (n,2) to the nearest segment of S (m,2,2); returns (dist, nearest point)."""
    a, b = S[:, 0], S[:, 1]; d = b - a; L = np.maximum((d * d).sum(1), 1e-12)
    t = np.clip(((pts[:, None, :] - a[None]) * d[None]).sum(2) / L[None], 0, 1)
    q = a[None] + t[..., None] * d[None]; dist = np.linalg.norm(pts[:, None, :] - q, axis=2)
    k = dist.argmin(1); return dist[np.arange(len(pts)), k], q[np.arange(len(pts)), k]


def find_opening(ring, S, neighbours, step=0.1, gap=0.3, min_width=0.6):
    """Longest run of the room boundary with no wall within `gap` m that leads into a neighbouring room
    (an entrance without a door; facade glazing set back from the space boundary is not an entrance)."""
    pts, tang = [], []
    for i in range(len(ring)):
        a, b = np.asarray(ring[i], float), np.asarray(ring[(i + 1) % len(ring)], float); L = np.linalg.norm(b - a)
        for t in np.arange(0, L, step): pts.append(a + (b - a) * t / L); tang.append((b - a) / L)
    pts = np.array(pts); dist, _ = seg_distance(pts, S)
    nb = np.zeros(len(pts), bool)
    for r in neighbours:
        R = np.array([[r[i], r[(i + 1) % len(r)]] for i in range(len(r))], float)
        nb |= seg_distance(pts, R)[0] < 0.5
    open_ = (dist > gap) & nb
    if open_.all() or not open_.any(): return None
    start = int(np.argmin(open_))                                   # rotate so the sequence starts on a wall
    o = np.roll(open_, -start); best, run, k0 = (0, 0), 0, 0
    for k, v in enumerate(o):
        if v: run += 1; k0 = k0 if run > 1 else k
        else: run = 0
        if run * step > best[0] * step: best = (run, k0)
    if best[0] * step < min_width: return None
    i0 = (best[1] + start) % len(pts); i1 = (best[1] + start + best[0] - 1) % len(pts)
    # the panel goes on the wall at one end of the opening: take the end that really has a wall next to it
    ends = [(pts[i0] - tang[i0] * 0.25, tang[i0]), (pts[i1] + tang[i1] * 0.25, tang[i1])]
    d = seg_distance(np.array([e[0] for e in ends]), S)[0]
    p, t = ends[int(np.argmin(d))]
    return p, t, best[0] * step                                       # panel point, boundary direction, opening width


def analyse(design, model, rooms, settings, origin, walls=None):
    s = {**DEFAULTS, **(settings or {})}
    els = model['elements']
    doors = [e for e in els if e['bbox'] and (e['type'] == 'IFCDOOR' or e['name'].upper().startswith('DOO'))]
    hatches = [e for e in els if e['bbox'] and ('检修口' in e['name'] or 'ACCESS' in e['name'].upper())]
    scheme = design['schemes'][design['activeScheme']]
    loc = lambda w: np.array([w[0] - origin[0], w[1] - origin[1], w[2] - origin[2]])
    out, warnings = [], []
    room_ids = [g for g in rooms if any(f.get('roomId') == g for f in scheme['fixtures'])]
    for n, gid in enumerate(sorted(room_ids, key=lambda g: rooms[g]['name']), 1):
        room = rooms[gid]; code = f'R{n:02d}'; ring = room['footprint']
        fx = [f for f in scheme['fixtures'] if f.get('roomId') == gid]
        # control groups
        groups = {}
        for f in fx:
            name = (f.get('electrical') or {}).get('group') or TYPE_LABEL.get(f['fixtureType'], f['fixtureType'])
            groups.setdefault(name, []).append(f)
        glist = []
        for k, (name, members) in enumerate(groups.items(), 1):
            glist.append({'id': f'{code}-L{k}', 'name': name, 'fixtures': members,
                          'power': sum(m['photometricParameters'].get('power') or 0 for m in members),
                          'dimmable': True})
        # control panel beside the door
        best = None
        for d in doors:
            lo, hi = local_bbox(d); c = (lo[:2] + hi[:2]) / 2
            dist, q, tang, _ = nearest_on_ring(c, ring)
            if dist < 0.6 and (best is None or dist < best[0]):
                width = max(hi[0] - lo[0], hi[1] - lo[1]); best = (dist, q, tang, width, d['name'])
        # neighbours: other rooms on the floor, not spaces that contain this one (e.g. a whole-apartment zone)
        neighbours = [r['footprint'] for g2, r in rooms.items() if g2 != gid and abs(r['floor'] - room['floor']) < 0.5
                      and not all(inside(p, r['footprint']) for p in ring)]
        opening = None if best or walls is None or not len(walls) else find_opening(ring, walls, neighbours)
        if best:
            _, q, tang, width, dname = best
            p = q + tang * (width / 2 + 0.25)
            if not inside(p, ring): p = q - tang * (width / 2 + 0.25)
            note = f'门旁（{dname}）'
        elif opening:
            p, tang, width = opening                                    # on the wall at the better end of the opening
            note = f'房间开口旁（无门，开口约 {width:.1f} m），需确认'
        else:
            p = np.asarray(ring[0], float); note = '未找到房间门或开口，面板位置需人工确认'
            warnings.append(f'{room["name"]}：{note}')
        if walls is not None and len(walls):                         # snap onto the actual wall face
            dist, q = seg_distance(np.array([p]), walls)
            if dist[0] < 0.35:
                inward = np.array([-tang[1], tang[0]]) if (best or opening) else np.zeros(2)
                if (best or opening) and not inside(q[0] + inward * 0.1, ring): inward = -inward
                p = q[0] + inward * 0.03
        panel = {'id': f'{code}-SP1', 'pos': p, 'z': room['floor'] + s['panelHeight'], 'note': note}
        # low-voltage supply
        drivers = []
        for g in glist:
            lv = [f for f in g['fixtures'] if supply(f, s) != 'mains']
            if not lv: continue
            V = int(supply(lv[0], s)[2:]); load = sum(f['photometricParameters'].get('power') or 0 for f in lv)
            cx, cy = np.mean([loc(f['position']['ifcWorld'])[:2] for f in lv], 0)
            spot, where = None, '房间中部吊顶内（未找到检修口，需确认可检修）'
            for h in hatches:
                lo, hi = local_bbox(h); c = (lo[:2] + hi[:2]) / 2
                if inside(c, ring) and (spot is None or np.hypot(*(c - [cx, cy])) < np.hypot(*(spot - [cx, cy]))):
                    spot, where = c, f'检修口 {h["name"]} 旁'
            if spot is None: spot = np.array([cx, cy]); warnings.append(f'{room["name"]} {g["id"]}：{where}')
            need = load * s['driverMargin']
            size = next((x for x in DRIVER_SIZES if x >= need), None)
            if size is None:
                size = DRIVER_SIZES[-1]; warnings.append(f'{room["name"]} {g["id"]}：负载 {load:.0f} W 超过单台 {size} W，需拆分驱动')
            runs = []
            for f in lv:
                fp = loc(f['position']['ifcWorld'])
                pts, L = manhattan(spot, fp[:2]); L += 0.5                       # + drops / tails
                P = f['photometricParameters'].get('power') or 0; I = P / V
                choice = None
                for A in CABLE_SIZES:
                    dU = 2 * L * I * RHO_CU / A
                    if dU / V * 100 <= s['dropLimit']: choice = (A, dU); break
                if choice is None:
                    A = CABLE_SIZES[-1]; choice = (A, 2 * L * I * RHO_CU / A)
                    warnings.append(f'{f["name"]}：{L:.1f} m 低压线路压降超限，需移近驱动或改用更高电压')
                runs.append({'fixture': f, 'points': pts, 'length': L, 'current': I, 'section': choice[0],
                             'drop': choice[1], 'dropPct': choice[1] / V * 100})
            drivers.append({'id': f'{g["id"]}-D1', 'group': g['id'], 'pos': spot, 'voltage': V, 'load': load,
                            'rating': size, 'where': where, 'runs': runs})
        scenes = default_scenes(glist)
        out.append({'code': code, 'room': room, 'roomId': gid, 'groups': glist, 'panel': panel, 'drivers': drivers, 'scenes': scenes})
    return out, warnings, s


def supply(f, s):
    e = f.get('electrical') or {}
    if e.get('supply'): return e['supply']
    return f"lv{s['lvVoltage']}" if f['fixtureType'] == 'linear' else 'mains'


def default_scenes(groups):
    """Generic residential scenes (levels in %, editable later): all on, everyday, ambience, night, off."""
    def lvl(g, table): return table.get(g['name'], table.get('*', 0))
    presets = [('全开', {'*': 100}), ('日常', {'筒灯': 80, '射灯': 60, '线性灯': 60, '吊灯': 70, '吸顶灯': 80, '*': 80}),
               ('氛围', {'筒灯': 20, '射灯': 50, '线性灯': 70, '吊灯': 60, '吸顶灯': 30, '*': 30}), ('夜灯', {'线性灯': 15, '*': 0}), ('全关', {'*': 0})]
    return [{'name': n, 'levels': {g['id']: lvl(g, t) for g in groups}} for n, t in presets]


# ---------------------------------------------------------------- DXF writing
def new_doc(title):
    doc = ezdxf.new('R2018', setup=True)
    doc.units = ezdxf.units.MM; doc.header['$INSUNITS'] = 4
    doc.styles.add('WEA-CN', font='simhei.ttf')
    for name, color in LAYERS.items():
        doc.layers.add(name, color=color)
    doc.layers.get('E-CTRL-LINK').dxf.linetype = 'DASHED'
    doc.layers.get('E-PWR-SW').dxf.linetype = 'DASHED'
    doc.header['$LTSCALE'] = 200
    doc.set_modelspace_vport(height=20000, center=(0, 0))
    return doc


def T(msp, text, x, y, h=150, layer='E-TEXT', align=TextEntityAlignment.LEFT, color=None):
    e = msp.add_text(str(text), height=h, dxfattribs={'layer': layer, 'style': 'WEA-CN', **({'color': color} if color else {})})
    e.set_placement((x, y), align=align)
    return e


def mm(p, origin):          # IFC local (m) -> IFC world (mm)
    return ((p[0] + origin[0]) * 1000.0, (p[1] + origin[1]) * 1000.0)


def draw_base(msp, segs, rooms_out, origin):
    for a, b in segs:
        msp.add_line(mm(a, origin), mm(b, origin), dxfattribs={'layer': 'A-WALL'})
    for r in rooms_out:
        ring = [mm(p, origin) for p in r['room']['footprint']]
        msp.add_lwpolyline(ring, close=True, dxfattribs={'layer': 'E-ROOM'})
        cx, cy = np.mean(ring, 0)
        T(msp, f"{r['code']} {r['room']['name']}", cx, cy + 400, 220, align=TextEntityAlignment.MIDDLE_CENTER)


def fixture_symbol(msp, f, origin, loc):
    p = mm(loc(f['position']['ifcWorld']), origin); t = f['fixtureType']
    if t == 'linear':
        L = (f['photometricParameters'].get('length') or 1) * 1000; b = math.radians(f['rotation'].get('bodyRotation') or 0)
        dx, dy = math.cos(b) * L / 2, math.sin(b) * L / 2; nx, ny = -math.sin(b) * 40, math.cos(b) * 40
        msp.add_lwpolyline([(p[0] - dx + nx, p[1] - dy + ny), (p[0] + dx + nx, p[1] + dy + ny), (p[0] + dx - nx, p[1] + dy - ny), (p[0] - dx - nx, p[1] - dy - ny)], close=True, dxfattribs={'layer': 'E-FIXT'})
    elif t == 'luminous':                                           # luminous surface: diamond at the emitting area's centre
        r = 200
        msp.add_lwpolyline([(p[0], p[1] + r), (p[0] + r, p[1]), (p[0], p[1] - r), (p[0] - r, p[1])], close=True, dxfattribs={'layer': 'E-FIXT'})
        msp.add_circle(p, 40, dxfattribs={'layer': 'E-FIXT'})
    elif t == 'ceiling':                                            # ceiling light: circle to scale + centre dot
        r = max(150, (f['photometricParameters'].get('diameter') or .4) * 500)
        msp.add_circle(p, r, dxfattribs={'layer': 'E-FIXT'}); msp.add_circle(p, 30, dxfattribs={'layer': 'E-FIXT'})
    elif t == 'pendant':                                            # decorative pendant: double circle + cross
        r = max(150, (f['photometricParameters'].get('diameter') or .5) * 500)
        msp.add_circle(p, r, dxfattribs={'layer': 'E-FIXT'}); msp.add_circle(p, r * .45, dxfattribs={'layer': 'E-FIXT'})
        msp.add_line((p[0] - r, p[1]), (p[0] + r, p[1]), dxfattribs={'layer': 'E-FIXT'})
        msp.add_line((p[0], p[1] - r), (p[0], p[1] + r), dxfattribs={'layer': 'E-FIXT'})
    else:
        msp.add_circle(p, 120, dxfattribs={'layer': 'E-FIXT'})
        if t == 'spotlight':
            a = math.radians(f['rotation'].get('aimAzimuth') or 0)
            msp.add_line(p, (p[0] + 260 * math.cos(a), p[1] + 260 * math.sin(a)), dxfattribs={'layer': 'E-FIXT'})
        else:
            msp.add_line((p[0] - 85, p[1] - 85), (p[0] + 85, p[1] + 85), dxfattribs={'layer': 'E-FIXT'})
            msp.add_line((p[0] - 85, p[1] + 85), (p[0] + 85, p[1] - 85), dxfattribs={'layer': 'E-FIXT'})
    return p


def title_block(msp, x, y, title, model_name, notes, w=12000):
    msp.add_lwpolyline([(x, y), (x + w, y), (x + w, y - 1500), (x, y - 1500)], close=True, dxfattribs={'layer': 'E-TITLE'})
    T(msp, title, x + 200, y - 450, 350, 'E-TITLE')
    T(msp, f'项目：{model_name}    日期：{datetime.date.today().isoformat()}    单位：mm    坐标：IFC 世界坐标', x + 200, y - 850, 160, 'E-TITLE')
    T(msp, notes, x + 200, y - 1200, 130, 'E-TITLE')


def legend(msp, x, y, items):
    """Legend symbols go to their own layer so device layers only contain real devices (countable in CAD)."""
    before = len(msp)
    T(msp, '图例', x, y, 220)
    for k, (draw, label) in enumerate(items):
        yy = y - 450 - k * 420; draw(msp, x + 300, yy); T(msp, label, x + 750, yy - 70, 150)
    for e in list(msp)[before:]:
        e.dxf.layer = 'E-LEGEND'


def plan_extent(rooms_out, origin, segs):
    pts = [mm(p, origin) for a, b in segs for p in (a, b)] or [mm(p, origin) for r in rooms_out for p in r['room']['footprint']]
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return min(xs), min(ys), max(xs), max(ys)


def control_plan(data, rooms_out, segs, origin, loc, model_name, s):
    doc = new_doc('照明控制平面图'); msp = doc.modelspace()
    draw_base(msp, segs, rooms_out, origin)
    for r in rooms_out:
        pp = mm(r['panel']['pos'], origin)
        msp.add_lwpolyline([(pp[0] - 140, pp[1] - 90), (pp[0] + 140, pp[1] - 90), (pp[0] + 140, pp[1] + 90), (pp[0] - 140, pp[1] + 90)], close=True, dxfattribs={'layer': 'E-CTRL-DEV'})
        T(msp, 'S', pp[0], pp[1], 120, 'E-CTRL-DEV', TextEntityAlignment.MIDDLE_CENTER)
        T(msp, f"{r['panel']['id']}  距地{s['panelHeight']:.1f}m", pp[0] + 200, pp[1] + 150, 120)
        for g in r['groups']:
            pts = [fixture_symbol(msp, f, origin, loc) for f in g['fixtures']]
            order = chain([pp] + pts)
            seq = [([pp] + pts)[i] for i in order]
            for a, b in zip(seq, seq[1:]):
                route, _ = manhattan(a, b)
                msp.add_lwpolyline(route, dxfattribs={'layer': 'E-CTRL-LINK'})
            for f, p in zip(g['fixtures'], pts):
                T(msp, g['id'], p[0] + 160, p[1] + 140, 110)
    x0, y0, x1, y1 = plan_extent(rooms_out, origin, segs)
    legend(msp, x1 + 1500, y1, [
        (lambda m, x, y: (m.add_circle((x, y), 120, dxfattribs={'layer': 'E-FIXT'}), m.add_line((x - 85, y - 85), (x + 85, y + 85), dxfattribs={'layer': 'E-FIXT'}), m.add_line((x - 85, y + 85), (x + 85, y - 85), dxfattribs={'layer': 'E-FIXT'})), '嵌入式筒灯（受控）'),
        (lambda m, x, y: (m.add_circle((x, y), 120, dxfattribs={'layer': 'E-FIXT'}), m.add_line((x, y), (x + 260, y), dxfattribs={'layer': 'E-FIXT'})), '可调角度射灯（线段示照射方向）'),
        (lambda m, x, y: m.add_lwpolyline([(x - 250, y - 40), (x + 250, y - 40), (x + 250, y + 40), (x - 250, y + 40)], close=True, dxfattribs={'layer': 'E-FIXT'}), '线性灯具（按实际长度）'),
        (lambda m, x, y: (m.add_circle((x, y), 150, dxfattribs={'layer': 'E-FIXT'}), m.add_circle((x, y), 68, dxfattribs={'layer': 'E-FIXT'}), m.add_line((x - 150, y), (x + 150, y), dxfattribs={'layer': 'E-FIXT'}), m.add_line((x, y - 150), (x, y + 150), dxfattribs={'layer': 'E-FIXT'})), '装饰吊灯（按灯罩直径）'),
        (lambda m, x, y: (m.add_circle((x, y), 150, dxfattribs={'layer': 'E-FIXT'}), m.add_circle((x, y), 30, dxfattribs={'layer': 'E-FIXT'})), '吸顶灯（按灯具直径）'),
        (lambda m, x, y: m.add_lwpolyline([(x - 140, y - 90), (x + 140, y - 90), (x + 140, y + 90), (x - 140, y + 90)], close=True, dxfattribs={'layer': 'E-CTRL-DEV'}), '智能控制面板 S（距地 1.3 m）'),
        (lambda m, x, y: m.add_line((x - 250, y), (x + 250, y), dxfattribs={'layer': 'E-CTRL-LINK'}), '控制逻辑连线（协议待定，非布线路由）'),
    ])
    title_block(msp, x0, y0 - 1200, '智能照明控制平面图（方案）', model_name,
                '控制协议待定：本图表达控制分组与面板对应关系；总线/地址待协议确定后深化。须经电气专业复核。', w=max(12000, x1 - x0))
    return doc


def lv_plan(data, rooms_out, segs, origin, loc, model_name, s):
    doc = new_doc('低压供电平面图'); msp = doc.modelspace()
    draw_base(msp, segs, rooms_out, origin)
    for r in rooms_out:
        for g in r['groups']:
            for f in g['fixtures']:
                fixture_symbol(msp, f, origin, loc)
        for d in r['drivers']:
            dp = mm(d['pos'], origin)
            msp.add_lwpolyline([(dp[0] - 200, dp[1] - 110), (dp[0] + 200, dp[1] - 110), (dp[0] + 200, dp[1] + 110), (dp[0] - 200, dp[1] + 110)], close=True, dxfattribs={'layer': 'E-LV-DRV'})
            T(msp, 'DRV', dp[0], dp[1], 110, 'E-LV-DRV', TextEntityAlignment.MIDDLE_CENTER)
            T(msp, f"{d['id']}  {d['voltage']}V {d['rating']}W（负载 {d['load']:.0f}W）", dp[0] + 260, dp[1] + 150, 120)
            for run in d['runs']:
                msp.add_lwpolyline([mm(p, origin) for p in run['points']], dxfattribs={'layer': 'E-LV-WIRE'})
                fp = mm(run['points'][-1], origin)
                T(msp, f"{run['section']}mm² L={run['length']:.1f}m ΔU={run['dropPct']:.1f}%", fp[0] + 160, fp[1] - 260, 100)
    x0, y0, x1, y1 = plan_extent(rooms_out, origin, segs)
    legend(msp, x1 + 1500, y1, [
        (lambda m, x, y: m.add_lwpolyline([(x - 200, y - 110), (x + 200, y - 110), (x + 200, y + 110), (x - 200, y + 110)], close=True, dxfattribs={'layer': 'E-LV-DRV'}), '恒压驱动电源 DRV（吊顶内，检修口旁）'),
        (lambda m, x, y: m.add_line((x - 250, y), (x + 250, y), dxfattribs={'layer': 'E-LV-WIRE'}), f"低压直流线路（{s['lvVoltage']}V，路由为正交示意）"),
        (lambda m, x, y: m.add_lwpolyline([(x - 250, y - 40), (x + 250, y - 40), (x + 250, y + 40), (x - 250, y + 40)], close=True, dxfattribs={'layer': 'E-FIXT'}), '低压线性灯具'),
    ])
    title_block(msp, x0, y0 - 1200, '低压灯具供电平面图（方案）', model_name,
                f"驱动额定 = 负载 × {s['driverMargin']}；压降 ΔU = 2·L·I·ρ/A（铜 ρ=0.0175），限值 {s['dropLimit']}%；线路长度按正交路由 + 0.5 m 估算。须经电气专业复核。", w=max(12000, x1 - x0))
    return doc


def board_symbol(msp, p, layer='E-PWR-BOARD'):
    msp.add_lwpolyline([(p[0] - 300, p[1] - 120), (p[0] + 300, p[1] - 120), (p[0] + 300, p[1] + 120), (p[0] - 300, p[1] + 120)], close=True, dxfattribs={'layer': layer})
    h = msp.add_hatch(color=1, dxfattribs={'layer': layer}); h.paths.add_polyline_path([(p[0] - 300, p[1] - 120), (p[0], p[1] - 120), (p[0], p[1] + 120), (p[0] - 300, p[1] + 120)], is_closed=True)


def power_plan(data, rooms_out, mains, segs, origin, loc, model_name, s):
    doc = new_doc('照明配电平面图'); msp = doc.modelspace()
    draw_base(msp, segs, rooms_out, origin)
    for r in rooms_out:
        for g in r['groups']:
            for f in g['fixtures']: fixture_symbol(msp, f, origin, loc)
        for d in r['drivers']:
            dp = mm(d['pos'], origin)
            msp.add_lwpolyline([(dp[0] - 200, dp[1] - 110), (dp[0] + 200, dp[1] - 110), (dp[0] + 200, dp[1] + 110), (dp[0] - 200, dp[1] + 110)], close=True, dxfattribs={'layer': 'E-LV-DRV'})
        pp = mm(r['panel']['pos'], origin)
        msp.add_lwpolyline([(pp[0] - 140, pp[1] - 90), (pp[0] + 140, pp[1] - 90), (pp[0] + 140, pp[1] + 90), (pp[0] - 140, pp[1] + 90)], close=True, dxfattribs={'layer': 'E-CTRL-DEV'})
    b = mains['board']; bp = mm(b['pos'], origin); board_symbol(msp, bp)
    T(msp, f"AL1 照明配电箱（{'' if b['confirmed'] else '待确认，'}箱底距地 {s['boardHeight']} m）", bp[0] + 400, bp[1] + 200, 150)
    for k, c in enumerate(mains['circuits']):
        col = CIRCUIT_COLORS[k % len(CIRCUIT_COLORS)]
        for sg in c['segments']:
            msp.add_lwpolyline([mm(q, origin) for q in sg['points']], dxfattribs={'layer': 'E-PWR', 'color': col, 'const_width': 45 if sg['kind'] == 'home' else 20})
            if sg['kind'] == 'home':
                q0, q1 = mm(sg['points'][1], origin), mm(sg['points'][-1], origin)
                T(msp, c['label'], (q0[0] + q1[0]) / 2 + 120, (q0[1] + q1[1]) / 2 + 120, 130, color=col)
        for sw in c['switchLegs']:
            msp.add_lwpolyline([mm(q, origin) for q in sw['points']], dxfattribs={'layer': 'E-PWR-SW', 'color': col, 'const_width': 10})
    x0, y0, x1, y1 = plan_extent(rooms_out, origin, segs)
    legend(msp, x1 + 1500, y1, [
        (lambda m, x, y: board_symbol(m, (x, y), 'E-LEGEND'), 'AL1 照明配电箱'),
        (lambda m, x, y: m.add_lwpolyline([(x - 250, y), (x + 250, y)], dxfattribs={'layer': 'E-PWR', 'const_width': 45}), '回路首段（配电箱 → 首个灯具），标注 回路-导线-保护管-敷设'),
        (lambda m, x, y: m.add_lwpolyline([(x - 250, y), (x + 250, y)], dxfattribs={'layer': 'E-PWR', 'const_width': 20}), '灯具间连线（同一回路同色）'),
        (lambda m, x, y: m.add_lwpolyline([(x - 250, y), (x + 250, y)], dxfattribs={'layer': 'E-PWR-SW', 'const_width': 10}), '开关线（控制面板 / 开关 → 灯具；采用智能控制时由控制模块替代）'),
        (lambda m, x, y: m.add_lwpolyline([(x - 140, y - 90), (x + 140, y - 90), (x + 140, y + 90), (x - 140, y + 90)], close=True, dxfattribs={'layer': 'E-CTRL-DEV'}), '开关 / 控制面板'),
    ])
    title_block(msp, x0, y0 - 1200, '照明配电平面图（方案）', model_name,
                f"回路电流 ≤ {s['maxCurrent']} A（GB 50034-2013 7.2.8：单相分支回路 ≤ 16 A、光源 ≤ 25 个），每回路 ≤ {s['maxRooms']} 个房间；线路为正交示意路由，未避让梁、风管与水管。须经电气专业复核。", w=max(12000, x1 - x0))
    return doc


def power_system(rooms_out, mains, model_name, s):
    doc = new_doc('照明配电系统图'); msp = doc.modelspace()
    T(msp, 'AL1 照明配电系统图（方案）', 0, 0, 350)
    n = len(mains['circuits']); top = -1200
    msp.add_lwpolyline([(1500, top), (1500, top - max(1, n) * 700)], dxfattribs={'layer': 'E-PWR', 'const_width': 40})   # busbar
    T(msp, '进线（由户内总箱 / 电表箱引来，规格待定）', 0, top + 300, 140)
    msp.add_line((0, top + 150), (1500, top + 150), dxfattribs={'layer': 'E-PWR'}); msp.add_line((1500, top + 150), (1500, top), dxfattribs={'layer': 'E-PWR'})
    for k, c in enumerate(mains['circuits']):
        y = top - 350 - k * 700
        msp.add_line((1500, y), (2600, y), dxfattribs={'layer': 'E-PWR'})
        msp.add_lwpolyline([(2600, y - 120), (3200, y + 120)], dxfattribs={'layer': 'E-PWR'})                 # breaker (switch symbol)
        msp.add_lwpolyline([(3200, y), (9000, y)], dxfattribs={'layer': 'E-PWR', 'color': CIRCUIT_COLORS[k % len(CIRCUIT_COLORS)], 'const_width': 20})
        T(msp, c['breaker'], 2550, y + 220, 120)
        T(msp, f"{c['label']}", 3400, y + 80, 130)
        T(msp, f"{c['power']:.0f} W · {c['current']:.2f} A · {c['fixtures']} 个负载 · {', '.join(c['rooms'])[:60]}", 3400, y - 220, 110)
    y = top - 350 - n * 700 - 600
    T(msp, '回路负荷与压降', 0, y, 250); y -= 400
    rows = [[c['id'], c['breaker'], c['label'].split(' ', 1)[1], f"{c['power']:.0f}", f"{c['current']:.2f}", str(c['fixtures']), f"{c['length']:.1f}", f"{c['drop']:.2f}",
             'OK' if c['drop'] <= s['mainsDropLimit'] else '超限', '、'.join(c['rooms'])[:40]] for c in mains['circuits']]
    y = table(msp, 0, y, ['回路', '断路器', '导线-保护管-敷设', '功率W', '电流A', '负载数', '线长m', 'ΔU %', '校核', '房间'], rows,
              [900, 1500, 2600, 900, 900, 900, 900, 900, 800, 5000]) - 600
    total = sum(c['power'] for c in mains['circuits'])
    T(msp, f"照明总安装功率 {total:.0f} W；功率因数 {s['powerFactor']}；驱动效率 {s['driverEfficiency']}（低压灯具按驱动额定 / 效率计入）。", 0, y, 140); y -= 400
    T(msp, '需人工确认 / 说明', 0, y, 250); y -= 350
    notes = mains['warnings'] + ['导线规格按 GB 50096 分支回路 ≥ 2.5 mm² 铜芯取值，压降超限时自动加大截面', '线长为正交路由 + 竖向段 + 每个灯具 0.5 m 估算，未避让梁、风管与水管']
    for k, w in enumerate(notes): T(msp, f'· {w}', 0, y - k * 260, 140)
    title_block(msp, 0, y - len(notes) * 260 - 400, '照明配电系统图（方案）', model_name, '回路划分、断路器与导线规格为方案估算，须经电气专业复核后方可用于施工。')
    return doc


def table(msp, x, y, headers, rows, widths, h=130, rh=360):
    W = sum(widths); n = len(rows) + 1
    for i in range(n + 1):
        msp.add_line((x, y - i * rh), (x + W, y - i * rh), dxfattribs={'layer': 'E-TABLE'})
    cx = x
    for wcol in widths + [0]:
        msp.add_line((cx, y), (cx, y - n * rh), dxfattribs={'layer': 'E-TABLE'}); cx += wcol
    for r, row in enumerate([headers] + rows):
        cx = x
        for wcol, cell in zip(widths, row):
            T(msp, cell, cx + 60, y - r * rh - rh * 0.65, h if r else h * 1.05, 'E-TABLE'); cx += wcol
    return y - n * rh


def system_sheet(rooms_out, model_name, s, warnings):
    doc = new_doc('照明控制系统图及表格'); msp = doc.modelspace()
    T(msp, '智能照明控制系统图（逻辑，协议待定）', 0, 0, 350)
    x = 0
    for r in rooms_out:                                   # one column per room: panel -> groups -> fixtures
        T(msp, f"{r['code']} {r['room']['name']}", x, -800, 200)
        msp.add_lwpolyline([(x, -1000), (x + 2600, -1000), (x + 2600, -1500), (x, -1500)], close=True, dxfattribs={'layer': 'E-CTRL-DEV'})
        T(msp, f"{r['panel']['id']} 控制面板", x + 120, -1330, 140)
        for k, g in enumerate(r['groups']):
            gy = -2200 - k * 900
            msp.add_line((x + 1300, -1500), (x + 1300, gy + 250), dxfattribs={'layer': 'E-CTRL-LINK'})
            msp.add_lwpolyline([(x, gy + 250), (x + 2600, gy + 250), (x + 2600, gy - 250), (x, gy - 250)], close=True, dxfattribs={'layer': 'E-FIXT'})
            T(msp, f"{g['id']} {g['name']} ×{len(g['fixtures'])}  {g['power']:.0f}W  调光", x + 120, gy - 60, 120)
            drv = [d for d in r['drivers'] if d['group'] == g['id']]
            if drv: T(msp, f"← {drv[0]['id']} {drv[0]['voltage']}V {drv[0]['rating']}W", x + 2700, gy - 60, 110)
        x += 4200
    y = -2200 - 900 * max(len(r['groups']) for r in rooms_out) - 800
    T(msp, '设备清单', 0, y, 250); y -= 400
    devs = []
    for r in rooms_out:
        devs.append([r['panel']['id'], '智能控制面板', r['room']['name'], '1', f"距地 {s['panelHeight']} m，{r['panel']['note']}"])
        for g in r['groups']:
            for t, c in sorted({f['fixtureType']: sum(1 for x in g['fixtures'] if x['fixtureType'] == f['fixtureType']) for f in g['fixtures']}.items()):
                devs.append([g['id'], TYPE_LABEL.get(t, t) + '（可调光）', r['room']['name'], str(c), '通用模拟灯具，型号待定'])
        for d in r['drivers']:
            devs.append([d['id'], f"恒压驱动 {d['voltage']}V {d['rating']}W", r['room']['name'], '1', d['where']])
    y = table(msp, 0, y, ['编号', '设备', '房间', '数量', '备注'], devs, [2200, 3200, 1600, 800, 7000]) - 600
    T(msp, '控制分组表', 0, y, 250); y -= 400
    rows = [[g['id'], g['name'], r['room']['name'], str(len(g['fixtures'])), f"{g['power']:.0f}", r['panel']['id'], ', '.join(f['name'] for f in g['fixtures'])[:60]]
            for r in rooms_out for g in r['groups']]
    y = table(msp, 0, y, ['分组', '名称', '房间', '灯具数', '功率W', '控制面板', '灯具'], rows, [1800, 1400, 1600, 900, 1000, 1800, 6500]) - 600
    T(msp, '场景表（默认值，调光百分比，可在调试时修改）', 0, y, 250); y -= 400
    rows = []
    for r in rooms_out:
        for sc in r['scenes']:
            rows.append([r['room']['name'], sc['name']] + [' / '.join(f"{gid.split('-')[-1]}:{v}%" for gid, v in sc['levels'].items())])
    y = table(msp, 0, y, ['房间', '场景', '各分组亮度'], rows, [1600, 1200, 9000]) - 600
    T(msp, f"低压驱动与压降校核（限值 {s['dropLimit']}%，铜 ρ=0.0175 Ω·mm²/m）", 0, y, 250); y -= 400
    rows = [[d['id'], run['fixture']['name'], f"{d['voltage']}", f"{run['current']:.2f}", f"{run['length']:.1f}", f"{run['section']}", f"{run['dropPct']:.2f}", 'OK' if run['dropPct'] <= s['dropLimit'] else '超限']
            for r in rooms_out for d in r['drivers'] for run in d['runs']]
    if rows:
        y = table(msp, 0, y, ['驱动', '灯具', 'V', 'I (A)', 'L (m)', '截面 mm²', 'ΔU %', '校核'], rows, [2200, 2200, 700, 900, 900, 1100, 900, 900]) - 600
    else:
        T(msp, '本方案没有低压灯具。', 0, y, 150); y -= 600
    T(msp, '需人工确认 / 说明', 0, y, 250); y -= 350
    for k, w in enumerate(warnings or ['无']):
        T(msp, f'· {w}', 0, y - k * 260, 140)
    title_block(msp, 0, y - len(warnings or [1]) * 260 - 400, '照明控制系统图及表格（方案）', model_name,
                '控制协议待定，未分配总线地址；所有数值为方案估算，须经电气专业复核后方可用于施工。')
    return doc


# ---------------------------------------------------------------- preview (SVG rendered from the very same DXF)
CJK_FONTS = ['/System/Library/Fonts/Hiragino Sans GB.ttc', '/System/Library/Fonts/STHeiti Medium.ttc',
             'C:/Windows/Fonts/simhei.ttf', 'C:/Windows/Fonts/msyh.ttc',
             '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc']


def preview_svg(doc):
    """SVG of the DXF model space (ezdxf drawing add-on). The DXF keeps simhei.ttf; for the preview only the
    text style is mapped to a CJK font installed on this machine."""
    from ezdxf.addons.drawing import Frontend, RenderContext, svg, layout
    from ezdxf.addons.drawing.config import Configuration, BackgroundPolicy
    font = next((Path(f).name for f in CJK_FONTS if Path(f).exists()), None)
    style = doc.styles.get('WEA-CN'); original = style.dxf.font
    if font: style.dxf.font = font
    try:
        b = svg.SVGBackend()
        cfg = Configuration(background_policy=BackgroundPolicy.CUSTOM, custom_bg_color='#16191d', min_lineweight=0.35, lineweight_scaling=2.0)
        Frontend(RenderContext(doc), b, config=cfg).draw_layout(doc.modelspace())
        return b.get_string(layout.Page(0, 0, layout.Units.mm, margins=layout.Margins.all(5)))
    finally:
        style.dxf.font = original


# ---------------------------------------------------------------- entry point
def generate(design, assets, settings=None, preview=False):
    assets = Path(assets)
    data = radiance_sim.load_model(assets); model = data['model']
    rooms_doc = json.loads((assets / 'rooms.json').read_text('utf-8'))
    rooms = rooms_doc['rooms']; origin = model.get('origin') or [0, 0, 0]
    loc = lambda w: (w[0] - origin[0], w[1] - origin[1], w[2] - origin[2])
    s0 = {**DEFAULTS, **(settings or {})}
    scheme = design['schemes'][design['activeScheme']]
    used = [rooms[f['roomId']] for f in scheme['fixtures'] if f.get('roomId') in rooms]
    if not used:
        raise ValueError('当前方案没有分配到房间的灯具')
    floor = min(r['floor'] for r in used)
    storey = [r for r in rooms.values() if abs(r['floor'] - floor) < 0.5]       # whole storey as drawing base
    lo = np.min([np.min(r['footprint'], 0) for r in storey], 0) - 2
    hi = np.max([np.max(r['footprint'], 0) for r in storey], 0) + 2
    segs = plan_cut(data, floor + s0['planCut'], (lo, hi))
    walls = np.array([[a, b] for a, b in segs]) if segs else np.zeros((0, 2, 2))
    rooms_out, warnings, s = analyse(design, model, rooms, settings, origin, walls)
    doors = [(*local_bbox(e), e['name']) for e in model['elements'] if e['bbox'] and (e['type'] == 'IFCDOOR' or e['name'].upper().startswith('DOO'))]
    mains = mains_circuits.plan_circuits(rooms_out, rooms, doors, s, origin, is_mains=lambda f: supply(f, s) == 'mains')
    s = {**mains['settings'], **s}; warnings = warnings + mains['warnings']
    storey_rooms = [{'code': '', 'room': r} for r in storey]
    name = model['name']
    files = {'01_照明控制平面图.dxf': control_plan(data, rooms_out, segs, origin, loc, name, s),
             '02_低压供电平面图.dxf': lv_plan(data, rooms_out, segs, origin, loc, name, s),
             '03_照明控制系统图及表格.dxf': system_sheet(rooms_out, name, s, warnings),
             '04_照明配电平面图.dxf': power_plan(data, rooms_out, mains, segs, origin, loc, name, s),
             '05_照明配电系统图.dxf': power_system(rooms_out, mains, name, s)}
    blobs = {}
    for fn, doc in files.items():
        buf = io.StringIO(); doc.write(buf); blobs[fn] = buf.getvalue().encode('utf-8')
    svgs = {fn: preview_svg(doc) for fn, doc in files.items()} if preview else None
    summary = {'rooms': [{'code': r['code'], 'name': r['room']['name'], 'panel': r['panel']['note'],
                          'groups': [{'id': g['id'], 'name': g['name'], 'fixtures': len(g['fixtures']), 'power': g['power']} for g in r['groups']],
                          'drivers': [{'id': d['id'], 'voltage': d['voltage'], 'rating': d['rating'], 'load': d['load'], 'where': d['where'],
                                       'maxDropPct': max((x['dropPct'] for x in d['runs']), default=0)} for d in d_list]}
                         for r in rooms_out for d_list in [r['drivers']]],
               'mains': {'board': {'note': mains['board']['note'], 'confirmed': mains['board']['confirmed']},
                         'circuits': [{k: c[k] for k in ('id', 'rooms', 'fixtures', 'power', 'current', 'breaker', 'section', 'label', 'length', 'drop')} for c in mains['circuits']]},
               'warnings': warnings, 'settings': {k: v for k, v in s.items() if k != 'board'}, 'planSegments': len(segs)}
    return (blobs, summary, svgs) if preview else (blobs, summary)
