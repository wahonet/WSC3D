"""Append reviewed face textures to the existing courtyard in an isolated Blender.

Run with Blender --background <20260905 blend> --python <this file>.
Only the exported texture overlays, two review cameras and review lighting are
added. Original stone geometry, transforms, IDs and architectural scene remain.
"""
import bpy
import importlib.util
import json
import traceback
from pathlib import Path
from mathutils import Matrix, Vector

import sys
sys.path.insert(0,str(Path(__file__).resolve().parent))
from project import stone_dir, stone_file, source_path, node_binary
ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'resources/authoring/scene-textures'
DATA = OUT / 'scene' / 'scene.json'
STATUS = OUT / 'blender-status.json'


def record(**values):
    STATUS.write_text(json.dumps(values, ensure_ascii=False, indent=2), encoding='utf-8')


def main():
    scene = bpy.context.scene
    if not scene.name.startswith('武氏祠_整体渲染_20260905'):
        raise RuntimeError('Only the courtyard scene from this task may be changed.')
    record(status='importing', scene=scene.name)
    payload = json.loads(DATA.read_text(encoding='utf-8'))
    manifest = json.loads((OUT / 'stoneTextureManifest.json').read_text(encoding='utf-8'))
    source_stones = {o['stone_id']: o for o in scene.objects if 'stone_id' in o and not o.get('stone_texture')}
    original = {o.name: list(sum((list(row) for row in o.matrix_world), []))
                for o in scene.objects}
    spec = importlib.util.spec_from_file_location('wsc_import', ROOT / 'tools/authoring/build_blender_scene.py')
    bridge = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bridge)
    bridge.SCENE_FILE = DATA
    bridge.PREFIX = 'WSC_TEX_'
    collection = bpy.data.collections.new('WSC_已核验画像石贴图')
    scene.collection.children.link(collection)
    records = [r for r in payload['objects'] if r.get('name', '').startswith('HPS-TEXTURE-')]
    if len(records) != len(manifest['entries']):
        raise RuntimeError(f'Expected {len(manifest["entries"])} overlay objects, got {len(records)}')
    material_records = {r['id']: r for r in payload['materials']}
    texture_records = {r['id']: r for r in payload['textures']}
    geometries = {r['id']: r for r in payload['geometries']}
    materials, image_cache, overlays = {}, {}, {}
    for r in records:
        sid = r['name'].removeprefix('HPS-TEXTURE-')
        if sid not in source_stones:
            raise RuntimeError('Overlay has no original stone: ' + sid)
        mids = r['materialIds']
        for mid in mids:
            if mid not in materials:
                materials[mid] = bridge.make_material(material_records[mid], texture_records, image_cache)
        mesh = bridge.make_mesh(geometries[r['geometryId']], mids, materials)
        obj = bpy.data.objects.new('WSC_TEX_' + sid, mesh)
        collection.objects.link(obj)
        values = r['matrixWorld']
        obj.matrix_world = bridge.C @ Matrix([values[i:i+4] for i in range(0, 16, 4)]).transposed()
        obj['stone_id'] = sid
        obj['stone_texture'] = True
        obj['source'] = next(x['sourcePath'] for x in manifest['entries'] if x['id'] == sid)
        obj['scope'] = '已核验扫描正面影像；贴在原示意石体表面，非扫描几何替换'
        overlays[sid] = obj
    for name, transform in original.items():
        current = list(sum((list(row) for row in scene.objects[name].matrix_world), []))
        if current != transform:
            raise RuntimeError('Original object moved: ' + name)
    assert all(image.packed_file for image in image_cache.values())
    scene['stone_texture_count'] = len(overlays)
    scene['stone_texture_manifest'] = str(OUT / 'stoneTextureManifest.json')
    scene['stone_texture_scope'] = '37件具名后厅石刻的确认单面影像；7幅背面/多面截图排除；占位A/B不推定'
    (OUT / 'blender').mkdir(exist_ok=True)
    (OUT / 'renders').mkdir(exist_ok=True)
    (OUT / 'blender' / 'texture-verification.json').write_text(json.dumps({
        'mapped_ids': sorted(overlays), 'mapped_count': len(overlays),
        'packed_texture_count': len(image_cache), 'original_object_count': len(original),
        'original_transforms_unchanged': True, 'source_file': bpy.data.filepath,
        'source_stone_id_count': len(source_stones),
    }, ensure_ascii=False, indent=2), encoding='utf-8')

    def center(obj):
        return sum((obj.matrix_world @ Vector(c) for c in obj.bound_box), Vector()) / 8

    representative = overlays['3 武梁祠东壁']
    normal = (representative.matrix_world.to_3x3() @ Vector((0, 0, 1))).normalized()
    wall_target = sum((center(overlays[sid]) for sid in ['2 武梁祠后壁', '3 武梁祠东壁', '4 武梁祠西壁']), Vector()) / 3
    cameras = []
    for name, target, distance, lens in [
        ('后展厅画像墙', wall_target, 4.7, 23),
        ('武梁祠东壁细节', center(representative), 3.2, 44),
    ]:
        camera = bridge.make_camera(scene, name, target + normal * distance + Vector((0, 0, .15)), target, lens=lens)
        cameras.append(camera)
    light_data = bpy.data.lights.new('WSC_TEX_展陈补光', 'AREA')
    light_data.energy = 380
    light_data.shape = 'DISK'
    light_data.size = 6
    light_data.color = (.95, .97, 1)
    light = bpy.data.objects.new('WSC_TEX_展陈补光', light_data)
    scene.collection.objects.link(light)
    light.location = wall_target + normal * 5 + Vector((0, 0, 1.7))
    bridge.look_at(light, wall_target)
    old_camera = scene.camera
    old_size = (scene.render.resolution_x, scene.render.resolution_y)
    old_filepath = scene.render.filepath
    scene.cycles.samples = 64
    scene.cycles.use_denoising = True
    prefs = bpy.context.preferences.addons['cycles'].preferences
    prefs.compute_device_type = 'OPTIX'
    prefs.refresh_devices()
    for device in prefs.devices:
        device.use = device.type == 'OPTIX'
    scene.cycles.device = 'GPU'
    destination = OUT / 'blender' / '武氏祠_画像石贴图.blend'
    bpy.ops.wm.save_as_mainfile(filepath=str(destination))
    # Inspection images omit glazing so reflection cannot conceal the mapped
    # evidence. Restore every visibility flag before saving the deliverable.
    glazing = []
    for obj in scene.objects:
        if obj.type != 'MESH' or obj.get('stone_texture'):
            continue
        for mat in obj.data.materials:
            if not mat or not mat.use_nodes:
                continue
            shaders = [n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED']
            if any(n.inputs['Transmission Weight'].default_value > .8 for n in shaders):
                glazing.append((obj, obj.hide_render))
                obj.hide_render = True
                break
    completed = []
    for camera, filename, size in [
        (cameras[0], '01_后展厅画像石贴图.png', (2200, 1400)),
        (cameras[1], '02_武梁祠东壁贴图细节.png', (1500, 1700)),
    ]:
        record(status='rendering', current=filename, completed=completed)
        scene.camera = camera
        scene.render.resolution_x, scene.render.resolution_y = size
        scene.render.filepath = str(OUT / 'renders' / filename)
        bpy.ops.render.render(write_still=True)
        completed.append(filename)
    light.hide_render = True
    for obj, hidden in glazing:
        obj.hide_render = hidden
    scene.camera = old_camera
    scene.render.resolution_x, scene.render.resolution_y = old_size
    scene.render.filepath = old_filepath
    bpy.ops.wm.save_as_mainfile(filepath=str(destination))
    record(status='complete', mapped_count=len(overlays), blend=str(destination), completed=completed)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        record(status='failed', error=traceback.format_exc())
        raise
