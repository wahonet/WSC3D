"""Import the shared Three.js courtyard into Blender; run through Blender MCP.

Geometry is generated from the same source as the HTML. Coordinates are metres:
Three (east, up, south) -> Blender (east, north, up). The user's existing scene
is retained. Run after `node tools/authoring/export_site_scene.mjs`.
"""
import bpy
import json
import math
from pathlib import Path
from mathutils import Matrix, Vector

import sys
sys.path.insert(0,str(Path(__file__).resolve().parent))
from project import stone_dir, stone_file, source_path, node_binary
PROJECT = Path(__file__).resolve().parents[2]
OUTPUT = PROJECT / 'resources/authoring/scene-base'
SCENE_FILE = OUTPUT / 'scene' / 'scene.json'
PREFIX = 'WSC_'
C = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))


def local_position(lx, lz, height=0):
    # The entrance origin and 45-degree courtyard axis come from buildSite.ts.
    gx, gz = (423.1 - 687) * .17639, (124.6 - 314) * .17639
    return Vector((gx + math.sqrt(.5) * (lx - lz),
                   -gz - math.sqrt(.5) * (lx + lz), height))


def look_at(obj, target):
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat('-Z', 'Y').to_euler()


def texture_node(nodes, links, image_info, uv_output, image_cache):
    path = (SCENE_FILE.parent / image_info['file']).resolve()
    cache_key = (str(path), image_info.get('encoding', 'srgb'))
    if cache_key not in image_cache:
        image = bpy.data.images.load(str(path), check_existing=False)
        image.name = PREFIX + path.stem
        image.colorspace_settings.name = 'sRGB' if cache_key[1] == 'srgb' else 'Non-Color'
        image.pack()
        image_cache[cache_key] = image
    tex = nodes.new('ShaderNodeTexImage')
    tex.image = image_cache[cache_key]
    tex.extension = 'REPEAT'
    tex.interpolation = 'Linear'
    mapping = nodes.new('ShaderNodeMapping')
    repeat = image_info.get('repeat', [1, 1])
    offset = image_info.get('offset', [0, 0])
    mapping.inputs['Scale'].default_value = (*repeat, 1)
    mapping.inputs['Location'].default_value = (*offset, 0)
    mapping.inputs['Rotation'].default_value[2] = image_info.get('rotation', 0)
    links.new(uv_output, mapping.inputs['Vector'])
    links.new(mapping.outputs['Vector'], tex.inputs['Vector'])
    return tex


def make_material(record, textures, image_cache):
    name = record.get('name') or f"{record['type']}_{record['id'][:8]}"
    mat = bpy.data.materials.new(PREFIX + name)
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    bsdf = next(n for n in nodes if n.type == 'BSDF_PRINCIPLED')
    color = record.get('color') or [.5, .5, .5]
    opacity = record.get('opacity', 1)
    mat.diffuse_color = (*color[:3], opacity)
    bsdf.inputs['Base Color'].default_value = (*color[:3], 1)
    if record.get('vertexColors'):
        vertex_color = nodes.new('ShaderNodeVertexColor')
        vertex_color.layer_name = 'Col'
        links.new(vertex_color.outputs['Color'], bsdf.inputs['Base Color'])
    bsdf.inputs['Metallic'].default_value = record.get('metalness', 0) or 0
    bsdf.inputs['Roughness'].default_value = record.get('roughness', .75) or .05
    bsdf.inputs['IOR'].default_value = 1.45
    maps = record.get('maps', {})
    uv = nodes.new('ShaderNodeTexCoord').outputs['UV']
    if maps.get('map') in textures:
        tex = texture_node(nodes, links, textures[maps['map']], uv, image_cache)
        mix = nodes.new('ShaderNodeMixRGB')
        mix.blend_type = 'MULTIPLY'
        mix.inputs[0].default_value = 1
        mix.inputs[2].default_value = (*color[:3], 1)
        links.new(tex.outputs['Color'], mix.inputs[1])
        links.new(mix.outputs[0], bsdf.inputs['Base Color'])
    bump_id = maps.get('bumpMap')
    if bump_id in textures:
        info = dict(textures[bump_id], encoding='linear')
        bump_tex = texture_node(nodes, links, info, uv, image_cache)
        bump = nodes.new('ShaderNodeBump')
        bump.inputs['Strength'].default_value = .35
        bump.inputs['Distance'].default_value = min(abs(record.get('bumpScale', .018) or .018), .045)
        links.new(bump_tex.outputs['Color'], bump.inputs['Height'])
        links.new(bump.outputs['Normal'], bsdf.inputs['Normal'])
    if opacity < .65 and record.get('transparent'):
        # Thin architectural glass; prevent the web's opacity hack from making
        # display cases opaque in a path-traced render.
        bsdf.inputs['Transmission Weight'].default_value = .94
        bsdf.inputs['Roughness'].default_value = .1
        bsdf.inputs['Alpha'].default_value = .22
    elif opacity < 1:
        bsdf.inputs['Alpha'].default_value = opacity
    if record.get('emissive'):
        bsdf.inputs['Emission Color'].default_value = (*record['emissive'][:3], 1)
        bsdf.inputs['Emission Strength'].default_value = record.get('emissiveIntensity', 0)
        if maps.get('emissiveMap') in textures:
            emission_tex = texture_node(nodes, links, textures[maps['emissiveMap']], uv, image_cache)
            emission_mix = nodes.new('ShaderNodeMixRGB')
            emission_mix.blend_type = 'MULTIPLY'
            emission_mix.inputs[0].default_value = 1
            emission_mix.inputs[2].default_value = (*record['emissive'][:3], 1)
            links.new(emission_tex.outputs['Color'], emission_mix.inputs[1])
            links.new(emission_mix.outputs[0], bsdf.inputs['Emission Color'])
    mat['source_material_id'] = record['id']
    return mat


def make_mesh(geo, material_ids, materials):
    positions = geo['positions']
    verts = [positions[i:i+3] for i in range(0, len(positions), 3)]
    indices = geo.get('index') or list(range(len(verts)))
    faces = [indices[i:i+3] for i in range(0, len(indices) - 2, 3)]
    mesh = bpy.data.meshes.new(PREFIX + geo['id'][:12])
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    colors = geo.get('colors')
    if colors:
        width = len(colors) // len(verts)
        if width not in (3, 4):
            raise ValueError('Unexpected vertex color size')
        attr = mesh.color_attributes.new(name='Col', type='FLOAT_COLOR', domain='POINT')
        rgba = []
        for i in range(len(verts)):
            rgba.extend(colors[i*width:i*width+3])
            rgba.append(colors[i*width+3] if width == 4 else 1)
        attr.data.foreach_set('color', rgba)
    for mid in material_ids:
        mesh.materials.append(materials[mid])
    for group in geo.get('groups', []):
        mid = group.get('materialIndex', 0)
        if mid < len(material_ids):
            for i in range(group['start']//3, min((group['start']+group['count'])//3, len(mesh.polygons))):
                mesh.polygons[i].material_index = mid
    uvs = geo.get('uv')
    if uvs:
        uv_layer = mesh.uv_layers.new(name='UVMap')
        loop_uvs = []
        for loop in mesh.loops:
            j = loop.vertex_index * 2
            loop_uvs.extend(uvs[j:j+2])
        uv_layer.data.foreach_set('uv', loop_uvs)
    normals = geo.get('normals')
    if normals and len(normals) == len(positions):
        mesh.polygons.foreach_set('use_smooth', [True]*len(mesh.polygons))
        mesh.normals_split_custom_set_from_vertices([normals[i:i+3] for i in range(0,len(normals),3)])
    return mesh


def make_camera(scene, name, position, target, lens=46, ortho=None):
    data = bpy.data.cameras.new(PREFIX + name)
    obj = bpy.data.objects.new(PREFIX + name, data)
    scene.collection.objects.link(obj)
    obj.location = Vector(position)
    look_at(obj, target)
    data.lens = lens
    data.clip_end = 2500
    if ortho:
        data.type = 'ORTHO'
        data.ortho_scale = ortho
    return obj


def build_scene():
    payload = json.loads(SCENE_FILE.read_text(encoding='utf-8'))
    source_label = '01-原始资料 CAD、现状参考照片；同源 src/frontend/src/archive/three/buildSite.ts'
    previous = [s for s in bpy.data.scenes if s.name.startswith('武氏祠_整体渲染_20260905') and s.get('source') == source_label]
    scene = bpy.data.scenes.new('武氏祠_整体渲染_20260905')
    bpy.context.window.scene = scene
    # Only replace draft scenes produced by this script in this task.
    for old in previous:
        for obj in list(old.objects):
            if obj.name.startswith(PREFIX):
                bpy.data.objects.remove(obj, do_unlink=True)
        for col in list(old.collection.children):
            if col.name.startswith(PREFIX):
                bpy.data.collections.remove(col)
        bpy.data.scenes.remove(old)
    scene.name = '武氏祠_整体渲染_20260905'
    for datablocks in (bpy.data.meshes, bpy.data.materials, bpy.data.images, bpy.data.worlds, bpy.data.cameras, bpy.data.lights):
        for block in list(datablocks):
            if block.name.startswith(PREFIX) and block.users == 0:
                datablocks.remove(block)
    scene.unit_settings.system = 'METRIC'
    scene['source'] = source_label
    scene['scope'] = '现状资料参考可视化，非测绘成果；设计方案与现状差异见随附说明'
    categories = {}
    for label in ['建筑与场地', '可隐藏屋顶', '石刻与展陈', '渲染灯光']:
        col = bpy.data.collections.new(PREFIX + label)
        scene.collection.children.link(col)
        categories[label] = col
    textures = {r['id']:r for r in payload['textures']}
    image_cache = {}
    materials = {r['id']:make_material(r,textures,image_cache) for r in payload['materials'] if r['type'] != 'ShaderMaterial'}
    geometries = {r['id']:r for r in payload['geometries']}
    mesh_cache = {}
    imported = 0
    stone_ids = set()
    for r in payload['objects']:
        if r.get('type') not in ('Mesh','InstancedMesh') or r.get('skipRender') or not r.get('geometryId'):
            continue
        mids = [mid for mid in r.get('materialIds',[]) if mid in materials]
        if not mids:
            continue
        key = (r['geometryId'], tuple(mids))
        if key not in mesh_cache:
            mesh_cache[key] = make_mesh(geometries[r['geometryId']], mids, materials)
        hps = r.get('hps') or {}
        sid = hps.get('id') if isinstance(hps,dict) else None
        name = r.get('name') or ('石刻_' + sid if sid else '构件')
        obj = bpy.data.objects.new(PREFIX + name, mesh_cache[key])
        col = categories['可隐藏屋顶' if r.get('roof') else '石刻与展陈' if sid else '建筑与场地']
        col.objects.link(obj)
        values = r['matrixWorld']
        obj.matrix_world = C @ Matrix([values[i:i+4] for i in range(0,16,4)]).transposed()
        obj.hide_render = not r.get('visible',True)
        obj['three_object_id'] = r['id']
        obj['is_roof'] = bool(r.get('roof'))
        if sid:
            obj['stone_id'] = sid
            stone_ids.add(sid)
        imported += 1
    scene.world = bpy.data.worlds.new(PREFIX + '日光天空')
    scene.world.use_nodes = True
    wn = scene.world.node_tree.nodes
    bg = next(n for n in wn if n.type == 'BACKGROUND')
    bg.inputs['Color'].default_value = (.63,.76,.92,1)
    bg.inputs['Strength'].default_value = .7
    sun_data = bpy.data.lights.new(PREFIX+'下午日光','SUN')
    sun_data.energy = 2.3
    sun_data.angle = math.radians(6)
    sun_data.color = (1,.88,.72)
    sun = bpy.data.objects.new(PREFIX+'下午日光',sun_data)
    categories['渲染灯光'].objects.link(sun)
    sun.location = local_position(5,-65,100)
    look_at(sun,local_position(52,-8,0))
    scene.render.engine = 'CYCLES'
    prefs = bpy.context.preferences.addons['cycles'].preferences
    try:
        prefs.compute_device_type = 'OPTIX'
        prefs.refresh_devices()
        for device in prefs.devices:
            device.use = device.type == 'OPTIX'
        scene.cycles.device = 'GPU'
    except Exception:
        scene.cycles.device = 'CPU'
    scene.cycles.samples = 64
    scene.cycles.use_denoising = True
    scene.cycles.max_bounces = 7
    scene.cycles.transparent_max_bounces = 8
    scene.render.resolution_x = 1600
    scene.render.resolution_y = 1000
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGB'
    scene.render.image_settings.color_depth = '8'
    scene.render.film_transparent = False
    scene.view_settings.view_transform = 'AgX'
    scene.view_settings.look = 'AgX - Medium High Contrast'
    scene.view_settings.exposure = .55
    target = local_position(56,-20,0)
    overview = make_camera(scene,'01_院落鸟瞰',local_position(-54,105,122),target,lens=41)
    overview.data.shift_y = -.06
    make_camera(scene,'02_中轴近景',local_position(-5,5,12),local_position(57,0,3),lens=32)
    plan_target=local_position(59,-21,0)
    make_camera(scene,'03_总平面',plan_target+Vector((0,0,180)),plan_target,ortho=163)
    scene.camera = overview
    for screen in bpy.data.screens:
        for area in screen.areas:
            if area.type == 'VIEW_3D':
                area.spaces.active.region_3d.view_perspective = 'CAMERA'
                area.spaces.active.clip_end = 2500
    scene['stone_id_count'] = len(stone_ids)
    report = {'scene':scene.name,'objects':imported,'meshes':len(mesh_cache),'materials':len(materials),'textures':len(image_cache),'stone_ids':sorted(stone_ids),'source':str(SCENE_FILE)}
    (OUTPUT/'blender'/'import_report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    bpy.ops.wm.save_as_mainfile(filepath=str(OUTPUT/'blender'/'武氏祠_整体场景.blend'))
    print(json.dumps({k:v for k,v in report.items() if k!='stone_ids'},ensure_ascii=False))
    return scene


if __name__ == '__main__':
    build_scene()
