"""Rectify carved stone faces from 2026-08 site photos into orthophoto textures for the Three scene.

usage: python tools/authoring/prepare_photo_stone_textures.py <quads.json>
       (defaults to resources/authoring/north-gallery-textures/bl-texture-quads.json, the north corridor)

Input : a quads file (see output/wushici-*-textures-*/ *-texture-quads.json) holding, per stone, the chosen
        photo(s), the pixel corners TL,TR,BR,BL of the carved face (broken stones as segments sharing the
        crack), the textured face normal in the stone's geometry-local axes and optional up / partName.
Output: resources/scenes/textures/stones/<id>.webp, the manifest named in the quads file (+ a copy and QA sheets
        next to the quads file).

Geometry: pinhole camera with EXIF 35 mm-equivalent focal length, principal point at the image centre.
For a well-conditioned view the true width/height of the annotated rectangle follows from the
K-consistency of the plane->image homography (K^-1 H must be a scaled rotation in its first two columns);
grazing views fall back to the measured size_cm. Broken stones are solved segment by segment with the
crack as the shared edge, then composited in one metric plane. Pixels are only re-sampled (homography),
never retouched, inpainted or generated. Model face sizes come from tools/authoring/dump_stone_faces.mjs, which
measures the built scene exactly as buildSite.ts' texture overlay will.

Per-entry `aspectSource` overrides the orientation policy: 'photo-metric' | 'meta-size_cm' | 'model-face'.
'model-face' (cut-out photos without EXIF, e.g. the pointed steles) treats the quad as the photo region that
maps 1:1 onto the bounding box of the model face, so shaped faces (pentagon + aperture) keep their features
aligned; the entry's `note` documents how the quad was placed.
"""
import hashlib
import json
import math
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageOps
from PIL.ExifTags import TAGS

import sys
sys.path.insert(0,str(Path(__file__).resolve().parent))
from project import stone_dir, stone_file, source_path, node_binary
ROOT = Path(__file__).resolve().parents[2]
DEST = ROOT / 'resources/scenes/textures/stones'
DIAG_35MM = math.hypot(36.0, 24.0)
FIT_TOLERANCE = 0.15          # texture vs model face aspect mismatch above this -> 'contain'
SUPERSAMPLE = 2
# Upright faces were photographed head-on at standing height: the perspective-derived aspect is reliable.
# Top faces of lying stones were shot obliquely from standing height with weak perspective, where a
# foreshortened rectangle is indistinguishable from a frontal thinner one, so measured size_cm decides.
ASPECT_POLICY = {'upright': 'photo-metric', 'upright-portrait': 'photo-metric', 'lying': 'meta-size_cm'}
AXES = {'+X': [1, 0, 0], '-X': [-1, 0, 0], '+Y': [0, 1, 0], '-Y': [0, -1, 0], '+Z': [0, 0, 1], '-Z': [0, 0, -1]}


# ----------------------------------------------------------------------------- camera / geometry
def load_photo(path, allow_no_exif=False):
    """Return (RGB array after EXIF orientation, K, 35 mm focal length, sha256, raw size).

    Without FocalLengthIn35mmFilm no camera matrix exists (K and f35 are None); only allowed for entries
    whose aspect comes from elsewhere ('meta-size_cm' / 'model-face'), e.g. cut-out stele photos."""
    raw = path.read_bytes()
    with Image.open(path) as im:
        exif = im.getexif().get_ifd(0x8769)
        tags = {TAGS.get(k, k): v for k, v in exif.items()}
        f35 = float(tags.get('FocalLengthIn35mmFilm') or 0)
        rgb = ImageOps.exif_transpose(im).convert('RGB')
    if not f35:
        if not allow_no_exif:
            raise SystemExit(f'{path}: missing FocalLengthIn35mmFilm, cannot build camera matrix')
        return np.asarray(rgb), None, None, hashlib.sha256(raw).hexdigest(), len(raw)
    W, H = rgb.size
    f = f35 / DIAG_35MM * math.hypot(W, H)
    K = np.array([[f, 0, W / 2], [0, f, H / 2], [0, 0, 1.0]])
    return np.asarray(rgb), K, f35, hashlib.sha256(raw).hexdigest(), len(raw)


def homography(src, dst):
    return cv2.getPerspectiveTransform(np.float32(src), np.float32(dst))


def metric_residual(plane, quad, K):
    """(cos angle between plane axes, relative scale difference) for plane->image homography."""
    M = np.linalg.inv(K) @ homography(plane, quad)
    m1, m2 = M[:, 0], M[:, 1]
    n1, n2 = np.linalg.norm(m1), np.linalg.norm(m2)
    return np.array([float(np.dot(m1, m2) / (n1 * n2)), float((n1 - n2) / (n1 + n2))])


def view_angle_deg(plane, quad, K):
    """Angle between the surface normal and the ray to the face centre (0 = frontal, 90 = grazing)."""
    H = homography(plane, quad)
    M = np.linalg.inv(K) @ H
    n = np.cross(M[:, 0], M[:, 1])
    c = H @ np.array([np.mean([p[0] for p in plane]), np.mean([p[1] for p in plane]), 1.0])
    d = np.linalg.inv(K) @ c
    cosang = abs(np.dot(n, d)) / (np.linalg.norm(n) * np.linalg.norm(d))
    return math.degrees(math.acos(min(1.0, cosang)))


def rect_aspect(quad, K):
    """Width/height of the imaged rectangle implied by K (plane->image), plus orthogonality residual."""
    M = np.linalg.inv(K) @ homography([[0, 0], [1, 0], [1, 1], [0, 1]], quad)
    m1, m2 = M[:, 0], M[:, 1]
    aspect = float(np.linalg.norm(m1) / np.linalg.norm(m2))
    cosang = float(np.dot(m1, m2) / (np.linalg.norm(m1) * np.linalg.norm(m2)))
    return aspect, cosang


def aspect_sensitivity(quad, K, px=3.0):
    """Relative change of the metric aspect for independent +-px corner errors (RSS over 8 coordinates).

    Frontal views barely react; grazing views of shallow faces explode, which marks them ill-conditioned."""
    a0, _ = rect_aspect(quad, K)
    total = 0.0
    for i in range(4):
        for axis in range(2):
            q = [list(p) for p in quad]
            q[i][axis] += px
            a, _ = rect_aspect(q, K)
            total += ((a - a0) / a0) ** 2
    return math.sqrt(total)


def solve_plane_x(quad, K, plane, free, init):
    """Gauss-Newton on the two K-consistency residuals: solve plane x of the two `free` corners."""
    pts = [list(p) for p in plane]
    u = np.array(init, float)

    def resid(v):
        for k, i in enumerate(free):
            pts[i][0] = float(v[k])
        return metric_residual(pts, quad, K)

    for _ in range(200):
        r = resid(u)
        if np.linalg.norm(r) < 1e-11:
            break
        J = np.zeros((2, 2))
        for k in range(2):
            dv = np.zeros(2)
            dv[k] = 1e-5
            J[:, k] = (resid(u + dv) - r) / 1e-5
        step = np.linalg.lstsq(J, -r, rcond=None)[0]
        u = u + np.clip(step, -0.25, 0.25)
    r = resid(u)
    return [list(p) for p in pts], float(np.linalg.norm(r))


def pixel_aspect(quad):
    TL, TR, BR, BL = [np.array(p, float) for p in quad]
    w = (np.linalg.norm(TR - TL) + np.linalg.norm(BR - BL)) / 2
    h = (np.linalg.norm(BL - TL) + np.linalg.norm(BR - TR)) / 2
    return float(w / h), float(w), float(h)


# ----------------------------------------------------------------------------- model faces
def axis_vector(v):
    if isinstance(v, str):
        return list(AXES[v])
    return [float(x) for x in v]


def axis_name(v):
    for name, a in AXES.items():
        if all(abs(x - y) < 1e-6 for x, y in zip(a, v)):
            return name
    return None


def dump_model_faces(ids):
    """Face extents / world directions of the candidate faces, measured on the built Three scene."""
    res = subprocess.run([node_binary(), str(ROOT / 'tools/authoring/dump_stone_faces.mjs'), *ids],
                         capture_output=True, cwd=ROOT, check=True)
    return json.loads(res.stdout.decode('utf-8'))


def model_face(dump, sid, item):
    """(normal, up, faceAspect, faceSize, kind, worldNormal) of the face named by the quads entry."""
    normal = axis_vector(item['normal'])
    key = (item['partName'] + '|' if item.get('partName') else '') + (axis_name(normal) or '')
    face = dump[sid]['faces'].get(key)
    if face is None:
        raise SystemExit(f"{sid}: no planar triangles for face '{key}' (have {sorted(dump[sid]['faces'])})")
    up = axis_vector(item['up']) if item.get('up') else None
    wn = face['worldNormal']
    if abs(wn[1]) > 0.7:
        kind = 'lying'
    elif up is not None and abs(up[1]) < 0.9:
        kind = 'upright-portrait'          # box rotated about its normal (e.g. BL R1-03): image up is a local X axis
    else:
        kind = 'upright'
    if up is None:
        up = [0, 0, -1.0 * np.sign(normal[1])] if abs(normal[1]) > 0.9 else [0, 1, 0]
    # width/height as buildSite will project them along (up x normal, up); a custom up swaps the extents
    default_up = [0, 0, -1.0 * np.sign(normal[1])] if abs(normal[1]) > 0.9 else [0, 1, 0]
    swapped = abs(float(np.dot(up, default_up))) < 0.5
    w, h = (face['height'], face['width']) if swapped else (face['width'], face['height'])
    return normal, [float(x) for x in up], w / h, [w, h], kind, wn


# ----------------------------------------------------------------------------- rendering
def output_size(aspect, height_m, ppm, max_side):
    h = height_m * ppm
    w = h * aspect
    scale = min(1.0, max_side / max(w, h))
    return max(2, int(round(w * scale))), max(2, int(round(h * scale)))


def warp(img, src_quad, dst_quad, size):
    """Homography re-sampling with 2x supersampling then area down-scale (anti-aliased)."""
    W, H = size
    s = SUPERSAMPLE
    M = homography(src_quad, [[x * s, y * s] for x, y in dst_quad])
    big = cv2.warpPerspective(img, M, (W * s, H * s), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
    return cv2.resize(big, (W, H), interpolation=cv2.INTER_AREA)


def render_single(img, quad, aspect, height_m, cfg):
    W, H = output_size(aspect, height_m, cfg['pixelsPerMetre'], cfg['maxSide'])
    return warp(img, quad, [[0, 0], [W, 0], [W, H], [0, H]], (W, H))


def solve_layout(segments):
    """Metric plane layout of consecutive segments sharing cracks. Plane units: stone width = 1."""
    layout = []
    x0, d = 0.0, 0.0
    for i, seg in enumerate(segments):
        quad, K = seg['quad'], seg['K']
        pa, wpx, hpx = pixel_aspect(quad)
        plane = [[0, 0], [pa, 0], [pa, 1], [d, 1]]
        solved, res = solve_plane_x(quad, K, plane, [1, 2], [pa, pa])
        w_top, w_bot = solved[1][0], solved[2][0]
        layout.append({
            'plane': [[x0 + p[0], p[1]] for p in solved],
            'residual': res,
            'viewAngleDeg': view_angle_deg(solved, quad, K),
            'topLength': w_top, 'bottomLength': w_bot - d,
        })
        d = w_bot - w_top
        x0 += w_top
    return layout


def render_segments(segments, layout, length_scale, height_m, cfg):
    """Composite all segments into one metric raster; later cracks are natural seams."""
    L_top = layout[-1]['plane'][1][0]
    L_bot = layout[-1]['plane'][2][0]
    L = (L_top + L_bot) / 2 * length_scale
    W, H = output_size(L, height_m, cfg['pixelsPerMetre'], cfg['maxSide'])
    sx, sy = W / L, H

    def to_px(p):
        return [p[0] * length_scale * sx, p[1] * sy]

    canvas = None
    for seg, lay in reversed(list(zip(segments, layout))):
        dst = [to_px(p) for p in lay['plane']]
        piece = warp(seg['img'], seg['quad'], dst, (W, H))
        if canvas is None:
            canvas = piece
            continue
        mask = np.zeros((H, W), np.uint8)
        cv2.fillPoly(mask, [np.int32(np.round(dst))], 255)
        # first segment also owns everything left of its crack, last segment everything right of it
        canvas = np.where(mask[..., None] > 0, piece, canvas)
    return canvas, L, (W, H)


# ----------------------------------------------------------------------------- QA sheet
def qa_sheet(rows, path, font):
    """Summary sheet: one row per stone, rectified texture thumbnail with its decision line."""
    tiles = []
    for r in rows:
        tex = Image.fromarray(r['texture'])
        tex.thumbnail((1400, 360))
        tile = Image.new('RGB', (1400, tex.height + 24), (28, 28, 28))
        tile.paste(tex, (0, 24))
        ImageDraw.Draw(tile).text((4, 3), r['label'], fill=(255, 220, 90), font=font)
        tiles.append(tile)
    sheet = Image.new('RGB', (1400, sum(t.height for t in tiles) + 6 * len(tiles)), (16, 16, 16))
    y = 0
    for t in tiles:
        sheet.paste(t, (0, y))
        y += t.height + 6
    sheet.save(path, quality=86)


def overview_image(img, quad, width=1000):
    im = Image.fromarray(img).copy()
    im.thumbnail((width, width))
    s = im.width / img.shape[1]
    d = ImageDraw.Draw(im)
    pts = [(x * s, y * s) for x, y in quad]
    d.line(pts + [pts[0]], fill=(255, 40, 40), width=3)
    return im


def qa_stone(segments, texture, path, font, caption):
    """Per-stone review image: each photo with its annotated quad, then the rectified texture."""
    parts = [overview_image(s['img'], s['quad']) for s in segments]
    tex = Image.fromarray(texture)
    tex.thumbnail((1000, 1000))
    width = max(p.width for p in parts + [tex])
    sheet = Image.new('RGB', (width, sum(p.height for p in parts) + tex.height + 28 + 8 * len(parts)), (16, 16, 16))
    y = 0
    for p in parts:
        sheet.paste(p, (0, y))
        y += p.height + 8
    ImageDraw.Draw(sheet).text((4, y + 4), caption, fill=(255, 220, 90), font=font)
    sheet.paste(tex, (0, y + 28))
    sheet.save(path, quality=86)
    return sheet


# ----------------------------------------------------------------------------- main
def main(quads_path):
    quads_path = Path(quads_path).resolve()
    task = quads_path.parent
    cfg = json.loads(quads_path.read_text(encoding='utf-8'))
    manifest_path = source_path(cfg['manifest'])
    dump = dump_model_faces(list(cfg['entries']))
    DEST.mkdir(parents=True, exist_ok=True)
    (task / 'qa').mkdir(parents=True, exist_ok=True)
    font = ImageFont.truetype('C:/Windows/Fonts/consola.ttf', 15) if Path('C:/Windows/Fonts/consola.ttf').exists() else ImageFont.load_default()
    entries, qa_rows, report = [], [], []
    total_bytes = 0

    for sid, item in cfg['entries'].items():
        meta = json.loads((stone_file(sid, 'meta.json')).read_text(encoding='utf-8'))
        size = meta['size_cm']
        fi = item.get('metaFace', [0, 1])
        meta_len, meta_h = size[fi[0]], size[fi[1]]
        meta_aspect = meta_len / meta_h
        height_m = meta_h / 100.0
        normal, up, face_aspect, face_size, kind, world_normal = model_face(dump, sid, item)

        policy = item.get('aspectSource') or ASPECT_POLICY[kind]
        seg_defs = item['segments'] if 'segments' in item else [{'photo': item['photo'], 'quad': item['quad']}]
        segments = []
        for s in seg_defs:
            path = source_path(Path(cfg['photoRoot']) / s['photo'])
            img, K, f35, sha, nbytes = load_photo(path, allow_no_exif=policy != 'photo-metric' and len(seg_defs) == 1)
            segments.append({'img': img, 'K': K, 'f35': f35, 'sha': sha, 'quad': s['quad'],
                             'path': Path(cfg['photoRoot'], s['photo']).as_posix(), 'imageSize': [img.shape[1], img.shape[0]]})

        rect = {'method': 'homography', 'pixelsPerMetre': cfg['pixelsPerMetre'], 'aspectSource': policy,
                'camera': 'pinhole, EXIF 35mm-equivalent focal length, principal point at image centre'}
        if len(segments) == 1:
            seg = segments[0]
            # 'model-face': the annotated rectangle is the photo region that maps onto the model face's
            # bounding box (used for cut-out photos of shaped stones such as the pointed steles)
            aspect = {'photo-metric': None, 'meta-size_cm': meta_aspect, 'model-face': face_aspect}[policy]
            if seg['K'] is None:
                rect['camera'] = 'none (no EXIF focal length; cut-out photo, aspect not derivable from perspective)'
                rect['photoPixelAspect'] = round(pixel_aspect(seg['quad'])[0], 4)
            else:
                metric_aspect, cosang = rect_aspect(seg['quad'], seg['K'])
                angle = view_angle_deg([[0, 0], [1, 0], [1, 1], [0, 1]], seg['quad'], seg['K'])
                if aspect is None:
                    aspect = metric_aspect
                rect.update({'photoMetricAspect': round(metric_aspect, 4), 'photoPixelAspect': round(pixel_aspect(seg['quad'])[0], 4),
                             'orthogonalityResidual': round(cosang, 4), 'viewAngleDeg': round(angle, 1),
                             'aspectSensitivity3px': round(aspect_sensitivity(seg['quad'], seg['K']), 4)})
            texture = render_single(seg['img'], seg['quad'], aspect, height_m, cfg)
        else:
            layout = solve_layout(segments)
            L_metric = (layout[-1]['plane'][1][0] + layout[-1]['plane'][2][0]) / 2
            length_scale = 1.0 if policy == 'photo-metric' else meta_aspect / L_metric
            texture, aspect, _ = render_segments(segments, layout, length_scale, height_m, cfg)
            rect.update({'photoMetricAspect': round(L_metric, 4), 'lengthScale': round(length_scale, 4),
                         'segments': [{'plane': [[round(v, 4) for v in p] for p in l['plane']],
                                       'residual': round(l['residual'], 6), 'viewAngleDeg': round(l['viewAngleDeg'], 1)} for l in layout],
                         'segmentShare': [round(l['topLength'] / sum(x['topLength'] for x in layout), 4) for l in layout]})

        H, W = texture.shape[:2]
        mismatch = abs(aspect / face_aspect - 1)
        fit = 'contain' if mismatch > FIT_TOLERANCE else 'face'
        file = sid.lower() + '.webp'
        Image.fromarray(texture).save(DEST / file, 'WEBP', quality=cfg['webpQuality'], method=6)
        total_bytes += (DEST / file).stat().st_size

        entry = {
            'id': sid, 'file': file, 'crop': [0, 0, W, H], 'imageSize': [W, H],
            'normal': normal, 'up': up, 'fit': fit,
        }
        if item.get('partName'):
            entry['partName'] = item['partName']
        entry.update({
            'sourceKind': 'site-photo-rectified',
            'sourcePath': segments[0]['path'] if len(segments) == 1 else [s['path'] for s in segments],
            'sourceSha256': segments[0]['sha'] if len(segments) == 1 else [s['sha'] for s in segments],
            'sourceImageSize': segments[0]['imageSize'],
            'sourceQuad': segments[0]['quad'] if len(segments) == 1 else [s['quad'] for s in segments],
            'focalLength35mm': segments[0]['f35'],
            'mappingEvidence': item.get('evidence') or f'2026-08盘点现场照片, 文件名前缀与 data/stones/{sid}/photos 目录编号一致',
            'rectification': rect,
            'textureAspect': round(aspect, 4),
            'metaSizeCm': size, 'metaFaceAspect': round(meta_aspect, 4),
            'modelFace': {'kind': kind, 'aspect': round(face_aspect, 4), 'size': face_size,
                          'worldNormal': world_normal},
        })
        if item.get('note'):
            entry['note'] = item['note']
        entries.append(entry)
        line = (f"{sid:9} {kind:16} tex {W:4}x{H:<4} aspect {aspect:6.3f} ({rect['aspectSource']:14}) "
                f"meta {meta_aspect:6.3f} model {face_aspect:6.3f} -> {fit}")
        report.append(line)
        qa_stone(segments, texture, task / 'qa' / f'{sid}.jpg', font,
                 f"{sid}  {' + '.join(Path(s['path']).name for s in segments)}   {W}x{H} aspect {aspect:.3f} "
                 f"[{rect['aspectSource']}] meta {meta_aspect:.3f} model {face_aspect:.3f} fit={fit}")
        qa_rows.append({'texture': texture, 'label': line})

    manifest = {
        'version': 1,
        'description': cfg.get('manifestDescription', cfg.get('description', '')),
        'imageTreatment': 'homography re-sampling of the annotated face only (2x supersample, area filter), WebP q85; '
                          'no retouching, inpainting or generation; crop is the full rectified image',
        'faceFrame': 'normal/up are in the stone geometry-local axes (see modelFace.worldNormal for the world direction)',
        'entries': entries,
    }
    text = json.dumps(manifest, ensure_ascii=False, indent=2) + '\n'
    manifest_path.write_text(text, encoding='utf-8')
    (task / manifest_path.name).write_text(text, encoding='utf-8')
    prefix = cfg.get('qaPrefix', 'texture-review')
    for i in range(0, len(qa_rows), 5):
        qa_sheet(qa_rows[i:i + 5], task / 'qa' / f'{prefix}-{i // 5 + 1}.jpg', font)
    print('\n'.join(report))
    print(json.dumps({'count': len(entries), 'displayBytes': total_bytes, 'manifest': str(manifest_path.relative_to(ROOT))}, ensure_ascii=False))


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else ROOT / 'resources/authoring/north-gallery-textures/bl-texture-quads.json')
