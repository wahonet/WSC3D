# 传承中心模型重建流程

武氏祠汉文化保护传承中心的建筑、项目附属（结构、机电、景观）与展陈装修模型均由施工图和设计文件生成。以下命令在项目根目录执行；Blender、LibreDWG（`dwg2dxf`）与 ezdxf 仅在制作时需要，浏览平台不依赖它们。制作脚本位于 `tools/authoring`，配方登记在 `config/authoring-recipes.json`。

## 建筑主模型

```powershell
# 1. 施工图 DWG 转 DXF（LibreDWG 0.14 的 dwg2dxf），输出到制作工程目录
dwg2dxf.exe -o resources\authoring\heritage-center\cad-20260925\sg-20260925.dxf "resources\reference\测绘与CAD\施工图纸\施工图_建筑20260925.dwg"
# 2. 提取各平面的轴网配准线稿、门窗与标高文字（需要额外安装 ezdxf，仅制作时使用）
python tools\authoring\extract_center_cad.py
# 3. 由各层平面推导室内墙体、柱、楼梯踏步、楼板和功能分区
powershell -NoProfile -ExecutionPolicy Bypass -File tools/run.ps1 tools/authoring/derive_center_floors.py
# 4. 生成立面材料贴图
powershell -NoProfile -ExecutionPolicy Bypass -File tools/run.ps1 tools/authoring/prepare_center_textures.py
# 5. Blender 5.2 建模并导出 resources/scenes/models/hanwenhua-center-20260925.glb
blender --background --factory-startup --python tools\authoring\build_center_blender.py
```

第 2 步的结果保存在 `resources/authoring/heritage-center/cad-20260925/views.json`。第 3 步生成同目录的 `floors.json`（含各层分区及颜色）；加 `--preview 目录` 可以输出各层检查图。第 5 步同时保存可编辑的 `.blend` 与 `build-report.json`，并写出前端图例用的 `src/frontend/src/center/centerZones.json`。每个网格都带有楼层标签 `center_level`（`B1`、`F1`、`F2`、`RF` 屋顶、`site` 场地）和角色标签 `center_role`，分区地面另带 `zone_id`，前端据此分层、着色和拾取。原 V2 模型保存在 `resources/authoring/heritage-center/v2/`，作为场地与乔木点位来源。重新导出后，需要把新文件的 SHA-256 和新的 `revision` 同时写入 `src/frontend/src/archive/three/hanwenhuaCenterPlacement.json`（同步复制到 `resources/georeferencing/hanwenhua-center-placement.json`）和 `src/frontend/src/center/centerProject.json`，再构建前端。

## 项目附属模型

传承中心模块的项目附属模型（结构、机电、景观、武氏祠白模）在完成上面第 1～5 步后制作：

```powershell
# 6. 结构、暖通、给排水与景观施工图转 DXF
$cad = "resources\reference\测绘与CAD\施工图纸"; $work = "resources\authoring\heritage-center\cad-20260925"
dwg2dxf.exe -o "$work\structure.dxf" "$cad\结构施工图260925.dwg"
dwg2dxf.exe -o "$work\hvac.dxf" "$cad\武氏祠暖通施工图.dwg"
dwg2dxf.exe -o "$work\plumbing.dxf" "$cad\武氏祠汉文化保护传承中心给排水施工图-W.dwg"
dwg2dxf.exe -o "$work\land-base.dxf" "$cad\9.24武氏祠景观施工图\土建\底图base.dwg"
dwg2dxf.exe -o "$work\planting.dxf" "$cad\9.24武氏祠景观施工图\绿化\P2.01-景观绿化施工图09.11_t3.dwg"
# 7. 按轴网配准结构与机电平面，按 CGCS2000 坐标配准景观，提取构件、管线与种植
python tools\authoring\extract_center_disciplines.py
# 8. Blender 建模并导出 resources/scenes/models/hanwenhua-center-project-20260927.glb
blender --background --factory-startup --python tools\authoring\build_center_project_blender.py
```

第 7 步输出同目录的 `disciplines.json` 和前端红线数据 `src/frontend/src/center/centerRedline.json`，景观要素在这一步按红线裁剪；加 `--preview 目录` 可以输出各专业检查图。第 8 步沿用主模型的坐标系和建模函数，武氏祠白模取自院落建筑模型并做体素重建与减面；可编辑的 `.blend` 和 `project-build-report.json` 保存在 `resources/authoring/heritage-center/blender/`。重新导出后，把新文件的 SHA-256 和新的 `revision` 写入 `src/frontend/src/center/centerProject.json`，再构建前端。

## 展陈装修模型

展陈装修模型在完成上面第 1～5 步后制作，设计文件放在 `resources/reference/测绘与CAD/施工图纸/武氏祠汉文化保护传承中心项目展陈设计文件9.18改(2).pdf`：

```powershell
# 9. 从设计文件效果图裁切、校正展陈贴图，并生成星空、沙面、石材等可平铺材质
powershell -NoProfile -ExecutionPolicy Bypass -File tools/run.ps1 tools/authoring/prepare_exhibition_textures.py
# 10. Blender 建模并导出 resources/scenes/models/hanwenhua-center-exhibition-20260927.glb
blender --background --factory-startup --python tools\authoring\build_center_exhibition_blender.py
```

第 9 步的贴图和裁切记录 `exhibit-manifest.json`（每张图的页码和裁切范围）保存在 `resources/authoring/heritage-center/textures/`。第 10 步沿用主模型的坐标系和材质函数，按建筑模型中各房间的墙面、柱位布置墙面饰面、展柜、展项、吊顶和灯带，并写出前端展厅数据 `src/frontend/src/center/centerExhibition.json`（章节、页码、房间、人视点与灯光）；可编辑的 `.blend` 保存在 `resources/authoring/heritage-center/blender/传承中心_展陈装修_20260927.blend`。每个网格带 `center_role = fitout`、`center_level` 和 `center_hall`，吊顶另带 `center_part = ceiling`。重新导出后，把新文件的 SHA-256 和新的 `revision` 写入 `src/frontend/src/center/centerProject.json` 的 `models.exhibition`，再构建前端。

## 院落建筑配色与鸱尾

院落建筑的配色与鸱尾由 `tools/authoring/refine_courtyard_glb.py` 追加，它以 `resources/authoring/courtyard-refine/before/` 中带交互门扇的模型为底稿，只改材质系数并追加屋面构件，重复执行结果一致。重新制作院落建筑后，应先把新的门扇模型放回该目录，再运行此脚本。
