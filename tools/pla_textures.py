#!/usr/bin/env python3
"""Recover texture images embedded in an Archicad archive (.pla / .pln), read-only.

The Archicad file format is proprietary and undocumented; this tool does not parse it. It carves
images by signature (file carving): raw PNG (chunk walk to IEND) and JPEG (SOI .. EOI, verified by a
full decode), plus images inside zlib streams. Every candidate is decoded with Pillow; anything that
does not decode completely is discarded. A name is attached only when a UTF-16 / ASCII file name
ending in an image extension appears shortly before the image (Archicad stores names next to the
embedded data); otherwise the file is named by its offset. The source file is never modified.

Archicad stores large files across several database pages, so a carved image can decode yet contain
foreign bytes (stripes, colour bands). Pillow tolerates that; libjpeg-turbo's djpeg reports it
("Corrupt JPEG data"), so when djpeg is available JPEGs are checked with it and damaged ones go to
damaged/ instead of the texture folder. Thumbnails (Archicad previews, < --min-size px) go to small/.

Usage: .venv/bin/python tools/pla_textures.py source/archicad/model.pla OUTDIR [--min-size 64]
"""
import argparse, hashlib, io, json, mmap, re, shutil, struct, subprocess, sys, zlib
from pathlib import Path
from PIL import Image

PNG, JPG = b'\x89PNG\r\n\x1a\n', b'\xff\xd8\xff'
NAME16 = re.compile(rb'(?:[\x20-\x7e]\x00|[\x00-\xff][\x4e-\x9f]){2,80}\.\x00(?:[jJ]\x00[pP]\x00[eE]?\x00?[gG]\x00|[pP]\x00[nN]\x00[gG]\x00|[tT]\x00[iI]\x00[fF]\x00|[bB]\x00[mM]\x00[pP]\x00)')
NAME8 = re.compile(rb'[\x20-\x7e]{2,80}\.(?:jpe?g|png|tiff?|bmp)', re.I)


def find_all(m, sig):
    i = m.find(sig)
    while i >= 0:
        yield i
        i = m.find(sig, i + 1)


def png_end(buf, start, max_chunks=200000):
    """Offset after IEND, walking the chunk structure; None as soon as a chunk type is not 4 letters."""
    p = start + 8
    for _ in range(max_chunks):
        if p + 12 > len(buf):
            return None
        n, typ = struct.unpack('>I4s', buf[p:p + 8])
        if not typ.isalpha() or n > 1 << 28:
            return None
        p += 12 + n
        if typ == b'IEND':
            return p
    return None


def jpeg_end(m, start, limit=64 << 20):
    """Offset after EOI, walking JPEG marker segments and entropy-coded data (baseline and progressive)."""
    p, stop = start + 2, min(len(m), start + limit)
    while p + 4 <= stop:
        if m[p] != 0xFF:
            return None
        mk = m[p + 1]
        if mk == 0xFF:
            p += 1; continue                                  # fill byte
        if mk == 0xD9:
            return p + 2
        if 0xD0 <= mk <= 0xD7 or mk == 0x01:
            p += 2; continue
        L = (m[p + 2] << 8) | m[p + 3]
        if L < 2:
            return None
        p += 2 + L
        if mk == 0xDA:                                        # scan data runs to the next real marker
            while True:
                q = m.find(b'\xff', p, stop)
                if q < 0 or q + 1 >= stop:
                    return None
                nx = m[q + 1]
                if nx == 0x00 or 0xD0 <= nx <= 0xD7:
                    p = q + 2; continue
                if nx == 0xFF:
                    p = q + 1; continue
                p = q; break
    return None


def decode(data):
    try:
        im = Image.open(io.BytesIO(data)); im.load()
        return im
    except Exception:
        return None


DJPEG = shutil.which('djpeg')


def intact(data, fmt):
    """(ok, message): strict integrity check. PNG: Pillow verifies chunk CRCs; JPEG: djpeg warnings."""
    if fmt == 'PNG':
        try:
            Image.open(io.BytesIO(data)).verify(); return True, ''
        except Exception as e:
            return False, str(e)
    if fmt == 'JPEG' and DJPEG:
        r = subprocess.run([DJPEG, '-outfile', '/dev/null'], input=data, capture_output=True)
        msg = r.stderr.decode('latin1').strip().splitlines()
        return r.returncode == 0 and not msg, (msg[0] if msg else '')
    return True, 'not verified (djpeg not installed)' if fmt == 'JPEG' else ''


def name_before(m, off, window=4096):
    chunk = m[max(0, off - window):off]
    hits = [(x.end(), x.group().decode('utf-16le', 'ignore')) for x in NAME16.finditer(chunk)]
    hits += [(x.end(), x.group().decode('latin1')) for x in NAME8.finditer(chunk)]
    if not hits:
        return None
    name = max(hits)[1]
    return re.split(r'[\\/]', name)[-1].strip() or None


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('archive'); ap.add_argument('outdir'); ap.add_argument('--min-size', type=int, default=64)
    a = ap.parse_args()
    out = Path(a.outdir); (out / 'small').mkdir(parents=True, exist_ok=True); (out / 'damaged').mkdir(exist_ok=True)
    f = open(a.archive, 'rb'); m = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
    seen, index, stats = set(), [], {'png': 0, 'jpg': 0, 'zlib': 0, 'rejected': 0, 'duplicates': 0, 'damaged': 0}

    def keep(data, im, off, source):
        h = hashlib.sha1(data).hexdigest()[:12]
        if h in seen:
            stats['duplicates'] += 1; return
        seen.add(h)
        name = name_before(m, off) or f'{off:010x}'
        ext = {'JPEG': '.jpg', 'PNG': '.png', 'TIFF': '.tif', 'BMP': '.bmp'}.get(im.format, '.bin')
        stem = re.sub(r'[^\w\-.#()一-鿿 ]', '_', Path(name).stem)[:80]
        small = min(im.size) < a.min_size
        ok, msg = intact(data, im.format)
        path = (out / ('damaged' if not ok else 'small' if small else '.')) / f'{stem}_{h}{ext}'
        path.write_bytes(data)
        stats['damaged'] += not ok
        index.append({'file': str(path.relative_to(out)), 'name': name, 'offset': off, 'source': source,
                      'format': im.format, 'size': list(im.size), 'mode': im.mode, 'bytes': len(data), 'small': small,
                      'intact': ok, 'check': msg})
        stats[source] += 1

    for off in find_all(m, PNG):
        end = png_end(m, off)
        data = m[off:end] if end else None
        im = decode(data) if data else None
        keep(data, im, off, 'png') if im else stats.__setitem__('rejected', stats['rejected'] + 1)
    for off in find_all(m, JPG):
        end = jpeg_end(m, off)
        data = m[off:end] if end else None
        im = decode(data) if data else None
        keep(data, im, off, 'jpg') if im else stats.__setitem__('rejected', stats['rejected'] + 1)
    zoffs = sorted(o for hdr in (b'\x78\x9c', b'\x78\xda', b'\x78\x01', b'\x78\x5e') for o in find_all(m, hdr))   # zlib headers
    print(f'png {stats["png"]} · jpg {stats["jpg"]} · zlib candidates {len(zoffs)}', file=sys.stderr, flush=True)
    for off in zoffs:
        d = zlib.decompressobj()
        try:
            head = d.decompress(m[off:off + 4096], 16)
        except zlib.error:
            continue
        if not (head.startswith(PNG) or head.startswith(JPG) or head.startswith(b'II*\x00') or head.startswith(b'MM\x00*')):
            continue
        try:
            d = zlib.decompressobj(); data = d.decompress(m[off:off + (256 << 20)])
        except zlib.error:
            continue
        im = decode(data)
        keep(data, im, off, 'zlib') if im else stats.__setitem__('rejected', stats['rejected'] + 1)
    index.sort(key=lambda r: r['offset'])
    (out / 'index.json').write_text(json.dumps({'archive': Path(a.archive).name, 'stats': stats, 'images': index},
                                               ensure_ascii=False, indent=1), encoding='utf-8')
    big = [r for r in index if not r['small'] and r['intact']]
    print(json.dumps(stats), f'intact textures ≥{a.min_size}px: {len(big)}, small/thumbnails: {sum(r["small"] and r["intact"] for r in index)}, damaged: {stats["damaged"]}', file=sys.stderr)


if __name__ == '__main__':
    main()
