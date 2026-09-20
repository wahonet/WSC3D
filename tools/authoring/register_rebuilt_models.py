from pathlib import Path
import json, sys
import shutil
sys.stdout.reconfigure(encoding='utf-8')
import sys
sys.path.insert(0,str(Path(__file__).resolve().parent))
from project import stone_dir, stone_file, source_path, node_binary
ROOT=Path(__file__).resolve().parents[2];OUT=ROOT / 'resources/authoring/stone-reconstruction'
def read(path):return json.loads(path.read_text(encoding='utf-8'))
def write(path,value):path.write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding='utf-8')
stone=stone_dir('占位石B 70×13.5×19')
m=read(stone/'metadata/catalogue.json')
m.update(group='武梁祠',size_cm=[19,70,13.5],size_source='published',size_display='残高70 cm；正面宽19 cm，侧面宽13.5 cm',technique='线刻纹饰；侧面画像雕刻、后刻题字')
m['face_identification']={'reference':'蒋英炬、吴文祺《汉代武氏墓群石刻研究（修订本）》2014，书页65、91，图版5.9','front':'19厘米宽面，连弧纹、线刻波浪纹','left':'左外侧，后刻“武家林”三字','right':'右内侧，相叠二人、翼龙、鸟首云纹','back':'素面，原贴靠东山墙'}
write(stone/'metadata/catalogue.json',m)
(stone/'notes/intro.md').write_text('此石为武梁祠前檐下东边条石残柱，原立于东山墙前檐角下。残高70厘米，19厘米宽的纹饰面朝前。\n\n正面饰连弧纹和线刻波浪纹；左外侧有后刻“武家林”三字；右内侧上部刻二人相叠，均举手左向，下者似托住上者的脚心，下部刻昂首翼龙，间饰鸟首云纹。背面为素面，原贴靠东山墙。\n\n依据：蒋英炬、吴文祺《汉代武氏墓群石刻研究（修订本）》（2014），书页65、91，图版5.9。整理照片文件名中的“正面”“右面”与原建筑方位不完全一致，系统按原文和画像内容重新对应三面。\n',encoding='utf-8')
media=read(stone/'metadata/media.json')
labels={'dc417f7ac582dd96ec41':'正面：连弧纹、波浪纹（原文件标“右面-A-02”）',
 'a292c3d2694bbb1369c7':'右内侧：相叠二人、翼龙（原文件标“侧面-A-01”）',
 '25d46ff5ea807c834029':'左外侧：后刻“武家林”三字（原文件标“正面-A-01”）',
 '01dbc659194c06f7d3db':'正面：连弧纹、波浪纹（原文件标“石右面-A-01.TIF”）'}
for item in media['items']:
 if item['id'] in labels:item['label']=labels[item['id']]
write(stone/'metadata/media.json',media)
for id in ['QUE-W','QUE-E','SHI-W','SHI-E']:
 folder=stone_dir(id);m=read(folder/'metadata/catalogue.json')
 model=folder/'models/gallery/photo-reconstruction-20260910.glb';assert model.is_file(),model
 isQue=id.startswith('QUE');isWest=id.endswith('W')
 # The concise imagery description belongs below the identity card; retain the full dossier under research.
 old_intro=(folder/'notes/intro.md').read_text(encoding='utf-8')
 research=folder/'notes/research.md';old_research=research.read_text(encoding='utf-8') if research.exists() else ''
 if '# 身份卡' in old_intro or '一物一档' in old_intro:
  backup=OUT/'backups'/research.relative_to(ROOT);backup.parent.mkdir(parents=True,exist_ok=True)
  if research.exists() and not backup.exists():shutil.copy2(research,backup)
  if old_intro.strip() not in old_research:research.write_text((old_research+'\n\n'+old_intro).strip()+'\n',encoding='utf-8')
 descriptions={
  'QUE-W':'西阙是武氏墓群神道入口的子母阙，与东阙相对。母阙由三层基座、三块叠砌阙身、栌斗和重檐四注顶组成，子阙傍依西侧。现存通高4.30米；主脊和子阙檐顶已佚。\n\n各面雕刻人物、车马、禽兽及神话题材，边框饰连弧纹等纹饰。母阙阙身北面第五格存武氏石阙铭，记东汉建和元年（147）造阙及石工姓名，是这组神道石刻的重要纪年依据。\n\n依据：2014修订本书页8–11。',
  'QUE-E':'东阙与西阙结构相同、左右对称，子阙傍依母阙东侧。现存通高4.28米，由分层基座、叠砌阙身、栌斗及母阙重檐四注顶组成；缺失的主脊和子阙檐顶不作无据补全。\n\n阙身、栌斗和基座分面刻人物、车马、禽兽及神话题材，间饰连弧纹等纹饰。母阙阙身西面有伏羲像及后人所刻“武氏祠”三字。\n\n依据：2014修订本书页9、11–13。',
  'SHI-W':'西石狮为东汉立体圆雕，四肢叉开迈步而基本站立，昂首、瞪目、张口，体下镂空。狮身粗壮，头颈刻鬈曲鬣毛，置于饰连弧纹和双菱纹的覆斗状基座上。\n\n本体高1.28米、残长1.48米，基座高0.33米；尾部、左前足、右后足残缺，嘴部略残。现状照片中的承托块随模型保留。与东石狮成对立于双阙前，据阙铭系东汉建和元年（147）所造。\n\n依据：2014修订本书页13–14，图2.6、2.7。',
  'SHI-E':'东石狮为东汉立体圆雕，四肢叉开迈步而基本站立，昂首、瞪目、张口，舌卷至上颚，头颈以线刻表现鬈曲鬣毛，体下镂空。右前爪按住一只蜷曲小兽，是辨识此狮的重要特征。\n\n本体高1.26米、残长1.58米，覆斗状基座高0.33米，四周饰连弧纹和双菱纹。尾和右后足残损。与西石狮成对立于双阙前，据阙铭系东汉建和元年（147）所造。\n\n依据：2014修订本书页13–14，图2.4、2.5。'}
 (folder/'notes/intro.md').write_text(descriptions[id]+'\n',encoding='utf-8')
 m['group']='武氏墓群神道石刻'
 description='依据四面实物照片及原书尺寸重建；浮雕细节为原照贴图，表面起伏为近似。' if isQue else '单张照片辅助重建，可见面使用清晰原照贴图；背面及未拍摄部位为近似推断，非精确扫描。'
 m['preferred_model']=model.name
 m['model_reconstruction']={'label':'照片重建 · 2026.09.10','description':description,'reference':'2014修订本书页8–9' if isQue else '2014修订本书页13–14','source_count':4 if isQue else 1,'view':([.68,.30,1.18] if isQue else [-1.2,.32,.90] if isWest else [1.25,.20,.86]),'measurement_model':False}
 if isQue:
  height=430 if isWest else 428;m['size_cm']=[260,height,141];m['size_display']=f'通高{height} cm；基座260 × 141 cm'
 else:
  height=161 if isWest else 159;m['size_cm']=[213,height,93];m['size_display']=f'通高{height} cm（含座）；基座213 × 93 × 33 cm'
 m['size_source']='published'
 write(folder/'metadata/catalogue.json',m)
print('Registered four preferred GLBs and corrected column description, sides and dimensions')
