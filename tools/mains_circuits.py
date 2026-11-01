#!/usr/bin/env python3
"""WEA — 220 V lighting circuits (强电照明回路) for the lighting design, as a schematic design draft.

From the rooms analysed by elv_drawings.analyse (fixtures, control panel = switch position):
  1. Distribution board AL1: designer position (elvSettings.board, set in the plan view) or, if absent,
     beside the entrance door — the door on the boundary of an entrance room (玄关 / 门厅 / 入户 …)
     whose other side is outside every room; else flagged for manual placement.
  2. Loads: 220 V fixtures at installed power, LV drivers at rating / efficiency (their primary side is 220 V).
  3. Circuits: rooms ordered by a nearest-neighbour walk from the board, filled greedily into circuits
     WL1, WL2 … within the limits (all editable):
       - current per single-phase branch ≤ maxCurrent (default 10 A design value; GB 50034-2013 §7.2.8:
         branch current should not exceed 16 A and 25 light sources)
       - ≤ maxFixtures fixtures and ≤ maxRooms rooms per circuit
     a room that alone exceeds a limit is split over several circuits (reported).
  4. Routes (orthogonal, schematic — no obstacle avoidance yet): board → nearest fixture of the first room,
     fixtures of a room joined by a minimum spanning tree (Manhattan), room to room from the nearest pair;
     switch leg from the room's control panel / switch to its nearest fixture.
  5. Cable length incl. vertical drops; voltage drop by load moments along the tree,
     ΔU = 2·ρ·Σ(I_k·L_k)/A; smallest section ≥ minSection meeting the limit (default 3 %).
Nothing here is a final electrical design: it is a draft for the responsible electrical engineer.
"""
import math
import numpy as np

RHO_CU = 0.0175
SECTIONS = [1.5, 2.5, 4.0, 6.0]
MAINS_DEFAULTS = {
    'voltage': 220, 'powerFactor': 0.9, 'driverEfficiency': 0.9,
    'maxCurrent': 10.0, 'breaker': 16, 'maxFixtures': 25, 'maxRooms': 8,
    'minSection': 2.5,                       # GB 50096: residential branch circuits ≥ 2.5 mm² copper
    'mainsDropLimit': 3.0, 'boardHeight': 1.8, 'tail': 0.5,
    'cable': 'BV-3×{s}', 'conduit': 'PC20', 'laying': 'CC',   # notation: 导线-根数×截面-保护管-敷设部位
}
ENTRANCE_WORDS = ('玄关', '门厅', '入户', '前厅', '过厅', 'entrance', 'foyer', 'entry', 'lobby')


def _inside(pt, ring):
    x, y = pt; c = False
    for i in range(len(ring)):
        (x1, y1), (x2, y2) = ring[i], ring[i - 1]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            c = not c
    return c


def _nearest_on_ring(p, ring):
    best = None
    for i in range(len(ring)):
        a, b = np.asarray(ring[i], float), np.asarray(ring[(i + 1) % len(ring)], float)
        d = b - a; L = float(d @ d)
        t = 0 if L == 0 else max(0, min(1, float((p - a) @ d) / L))
        q = a + t * d; dist = float(np.linalg.norm(p - q))
        if best is None or dist < best[0]:
            best = (dist, q, d / math.sqrt(L) if L else np.array([1., 0.]))
    return best


def manhattan_len(a, b):
    return abs(b[0] - a[0]) + abs(b[1] - a[1])


def ortho(a, b):
    return [tuple(map(float, a)), (float(b[0]), float(a[1])), tuple(map(float, b))]


def find_board(rooms, doors, settings, origin):
    """-> (pos (x, y) IFC local, z, note, confirmed)"""
    b = settings.get('board')
    if b and b.get('world'):
        pos = np.array([b['world'][0] - origin[0], b['world'][1] - origin[1]])
        host = [r for r in rooms.values() if _inside(pos, r['footprint'])]
        floor = min(host, key=lambda r: r['area'])['floor'] if host else min(r['floor'] for r in rooms.values())
        return pos, (b['z'] - origin[2] if b.get('z') is not None else floor + settings['boardHeight']), '设计师指定', True
    # candidate doors on any room boundary: a door leading out of the dwelling (one side outside every room) wins,
    # then rooms named like an entrance (玄关 …), then the nearest to the boundary
    best = None
    for room in rooms.values():
        ring = room['footprint']; named = any(w in room['name'].lower() for w in ENTRANCE_WORDS)
        if room['area'] > 150 and not named: continue                     # whole-unit spaces are not entrances
        for lo, hi, name in doors:
            c = (lo[:2] + hi[:2]) / 2
            dist, q, tang = _nearest_on_ring(c, ring)
            if dist > 0.6: continue
            n = np.array([-tang[1], tang[0]]); w = max(hi[0] - lo[0], hi[1] - lo[1])
            ext = any(not any(_inside(sp, r['footprint']) for r in rooms.values()) for sp in (c + n * 0.6, c - n * 0.6))
            if not (ext or named): continue
            score = (0 if ext else 1, 0 if named else 1, dist)
            if best is None or score < best[0]: best = (score, room, q, tang, w, name, ext)
    if best:
        _, room, q, tang, w, name, ext = best; ring = room['footprint']
        p = q + tang * (w / 2 + 0.4)
        if not _inside(p, ring): p = q - tang * (w / 2 + 0.4)
        n = np.array([-tang[1], tang[0]]); p = p + (n if _inside(p + n * 0.1, ring) else -n) * 0.05
        return p, room['floor'] + settings['boardHeight'], f"{room['name']} {'入户门' if ext else '门'}（{name}）旁，自动推定", False
    first = next(iter(rooms.values()))
    return np.asarray(first['footprint'][0], float), first['floor'] + settings['boardHeight'], '未找到入户空间，位置需人工指定', False


def mst(points):
    """Prim's minimum spanning tree on Manhattan distance -> list of (i, j) edges (i already connected)."""
    n = len(points); used = [False] * n; used[0] = True; edges = []
    best = [(manhattan_len(points[0], points[k]), 0) for k in range(n)]
    for _ in range(n - 1):
        k = min((i for i in range(n) if not used[i]), key=lambda i: best[i][0])
        used[k] = True; edges.append((best[k][1], k))
        for i in range(n):
            if not used[i]:
                d = manhattan_len(points[k], points[i])
                if d < best[i][0]: best[i] = (d, k)
    return edges


def plan_circuits(rooms_out, rooms, doors, settings=None, origin=(0, 0, 0), is_mains=lambda f: True):
    """rooms_out: elv_drawings.analyse output. Returns {'board', 'circuits', 'warnings', 'settings'}."""
    s = {**MAINS_DEFAULTS, **(settings or {})}
    warnings = []
    bpos, bz, bnote, bok = find_board(rooms, doors, s, origin)
    if not bok: warnings.append(f'配电箱 AL1：{bnote}；可在平面定位中用“配电箱”工具指定')
    loc = lambda w: np.array([w[0] - origin[0], w[1] - origin[1], w[2] - origin[2]])
    V, pf = s['voltage'], s['powerFactor']
    # loads per room: (item, plan position, height, power W)
    units = []
    for r in rooms_out:
        items = []
        for g in r['groups']:
            for f in g['fixtures']:
                if not is_mains(f): continue                       # LV fixture: fed by its driver (counted below)
                p = loc(f['position']['ifcWorld'])
                items.append({'kind': 'fixture', 'id': f['fixtureId'], 'name': f['name'], 'p': p[:2], 'z': p[2], 'P': float(f['photometricParameters'].get('power') or 0)})
        for d in r['drivers']:
            items.append({'kind': 'driver', 'id': d['id'], 'name': d['id'], 'p': np.asarray(d['pos'], float), 'z': (r['room']['ceilings'][0]['z'] if r['room'].get('ceilings') else r['room']['floor'] + 2.6),
                          'P': d['rating'] / s['driverEfficiency']})
        if items: units.append({'room': r, 'items': items})
    # visit rooms by nearest neighbour from the board (spatially coherent circuits)
    order, left, cur = [], list(range(len(units))), bpos
    while left:
        k = min(left, key=lambda i: min(manhattan_len(cur, it['p']) for it in units[i]['items']))
        order.append(units[k]); left.remove(k)
        cur = units[k]['items'][-1]['p']
    cur_I = lambda its: sum(it['P'] for it in its) / (V * pf)
    circuits, c = [], None
    for u in order:
        chunks, its = [], list(u['items'])
        while its:                                                 # split a room that alone exceeds a limit
            take = []
            while its and len(take) < s['maxFixtures'] and cur_I(take + [its[0]]) <= s['maxCurrent']: take.append(its.pop(0))
            if not take: take.append(its.pop(0)); warnings.append(f"{u['items'][0]['name']} 单灯电流超过 {s['maxCurrent']} A")
            chunks.append(take)
        if len(chunks) > 1: warnings.append(f"{u['room']['room']['name']} 负载超过单回路限值，拆分为 {len(chunks)} 个回路")
        for ch in chunks:
            if c is None or len(c['rooms']) >= s['maxRooms'] or c['n'] + len(ch) > s['maxFixtures'] or cur_I(c['items'] + ch) > s['maxCurrent']:
                c = {'rooms': [], 'items': [], 'n': 0}; circuits.append(c)
            c['rooms'].append({'room': u['room'], 'items': ch}); c['items'] += ch; c['n'] += len(ch)
    out = []
    for k, c in enumerate(circuits, 1):
        cid = f'WL{k}'
        segs, sw, nodes = [], [], {}                              # nodes: id -> (parent id, run length from board)
        prev_p, prev_id, prev_L, riser = bpos, 'AL1', 0.0, 0.0
        for rr in c['rooms']:
            its = rr['items']; pts = [it['p'] for it in its]; room = rr['room']['room']
            ceil = room['ceilings'][0]['z'] if room.get('ceilings') else room['floor'] + 2.6
            entry = min(range(len(its)), key=lambda i: manhattan_len(prev_p, pts[i]))
            if prev_id == 'AL1': riser = max(0.0, ceil - bz)      # riser from the board into the ceiling void
            L0 = prev_L + manhattan_len(prev_p, pts[entry]) + (riser if prev_id == 'AL1' else 0.0)
            segs.append({'from': prev_id, 'to': its[entry]['id'], 'points': ortho(prev_p, pts[entry]), 'kind': 'home' if prev_id == 'AL1' else 'link'})
            nodes[its[entry]['id']] = L0
            reorder = [entry] + [i for i in range(len(its)) if i != entry]
            sub = [pts[i] for i in reorder]
            for i, j in mst(sub):
                a, b = its[reorder[i]], its[reorder[j]]
                nodes[b['id']] = nodes[a['id']] + manhattan_len(a['p'], b['p'])
                segs.append({'from': a['id'], 'to': b['id'], 'points': ortho(a['p'], b['p']), 'kind': 'branch'})
            panel = rr['room'].get('panel')
            if panel is not None:
                tgt = its[entry]
                swL = manhattan_len(panel['pos'], tgt['p']) + max(0.0, ceil - panel['z'])
                sw.append({'room': room['name'], 'panel': panel['id'], 'to': tgt['id'], 'points': ortho(panel['pos'], tgt['p']), 'length': swL})
            far = max(reorder, key=lambda i: nodes[its[i]['id']])
            prev_p, prev_id, prev_L = pts[far], its[far]['id'], nodes[its[far]['id']]
        P = sum(it['P'] for it in c['items']); I = P / (V * pf)
        moment = sum(it['P'] / (V * pf) * (nodes[it['id']] + s['tail']) for it in c['items'])     # Σ I_k·L_k
        length = sum(manhattan_len(sg['points'][0], sg['points'][-1]) for sg in segs) + riser + s['tail'] * c['n']
        sec = next((A for A in SECTIONS if A >= s['minSection'] and 2 * RHO_CU * moment / A / V * 100 <= s['mainsDropLimit']), None)
        if sec is None:
            sec = SECTIONS[-1]; warnings.append(f'{cid}：压降超过 {s["mainsDropLimit"]}%（{2 * RHO_CU * moment / sec / V * 100:.1f}%），需缩短线路或拆分回路')
        drop = 2 * RHO_CU * moment / sec / V * 100
        label = f"{cid} {s['cable'].format(s=sec if sec != int(sec) else int(sec))}-{s['conduit']}-{s['laying']}"
        out.append({'id': cid, 'rooms': [rr['room']['room']['name'] for rr in c['rooms']], 'fixtures': c['n'],
                    'power': P, 'current': I, 'breaker': f"{s['breaker']}A 1P+N", 'section': sec, 'label': label,
                    'length': length, 'switchLegs': sw, 'drop': drop, 'segments': segs,
                    'items': [{'id': it['id'], 'name': it['name'], 'kind': it['kind'], 'P': it['P'], 'run': nodes[it['id']] + s['tail']} for it in c['items']]})
    return {'board': {'id': 'AL1', 'pos': bpos, 'z': bz, 'note': bnote, 'confirmed': bok}, 'circuits': out, 'warnings': warnings, 'settings': s}
