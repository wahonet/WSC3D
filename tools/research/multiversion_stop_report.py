"""Export the stopped multiversion run; never infer, import or mutate the DB."""
from __future__ import annotations

from collections import Counter
from datetime import datetime
from zoneinfo import ZoneInfo
from pathlib import Path
import csv
import hashlib
import json
import sqlite3

ROOT = Path('F:/wsc-unified')
OUT = ROOT / 'resources/authoring/research/multiversion-20261002'
DEST = OUT / 'stop-review-20261003'

def read(name):
    return json.loads((OUT / name).read_text(encoding='utf-8'))

def csv_file(name, rows):
    with (DEST / name).open('w', encoding='utf-8-sig', newline='') as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)

def main():
    audit = read('progress-audit.json')
    baseline = read('baseline.json')
    manifest = read('native-commits.json')
    decisions = read('native-decisions.json')
    alignments = read('alignment-commits.json')
    inventory = read('inventory.json')
    with sqlite3.connect((ROOT / 'data/stonelab.db').as_uri() + '?mode=ro', uri=True) as db:
        db.row_factory = sqlite3.Row
        tables = {table: [dict(row) for row in db.execute('SELECT * FROM ' + table)]
                  for table in ('annotations', 'annotation_references', 'annotation_concepts', 'stones', 'assets')}
    original_checks = {}
    for table in ('annotations', 'annotation_references', 'annotation_concepts', 'stones'):
        original = baseline[table]
        if original and 'id' in original[0]:
            current = {row['id']: row for row in tables[table]}
            mismatches = [row['id'] for row in original if current.get(row['id']) != row]
        else:
            present = {json.dumps(row, ensure_ascii=False, sort_keys=True) for row in tables[table]}
            mismatches = [row for row in original if json.dumps(row, ensure_ascii=False, sort_keys=True) not in present]
        original_checks[table] = {'original_count': len(original), 'mismatch_count': len(mismatches)}
        assert not mismatches, (table, mismatches[:3])
    anns = {row['id']: row for row in tables['annotations']}
    assets = {row['id']: row for row in tables['assets']}
    imported = manifest['versions']
    assert len(imported) == len(decisions['accepted']) == audit['native_versions_written'] == 187
    assert len(alignments['records']) == audit['saved_new_pairs'] == 263
    current_native = {row['id'] for row in tables['annotations']
                      if json.loads(row['geometry']).get('image_version', {}).get('native_boundary_reviewed') is True}
    assert current_native == {row['annotation_id'] for row in imported}
    refs = {}
    concepts = {}
    for row in tables['annotation_references']:
        refs.setdefault(row['annotation_id'], []).append(row)
    for row in tables['annotation_concepts']:
        concepts.setdefault(row['annotation_id'], []).append(row)
    levels = Counter()
    source_labels = Counter()
    same_source = []
    status_differences = []
    version_rows = []
    for record in imported:
        annotation = anns[record['annotation_id']]
        canonical = anns[record['canonical_annotation_id']]
        asset = assets[record['asset_id']]
        geom = json.loads(annotation['geometry'])
        metadata = geom['image_version']
        assert metadata['source_asset_id'] == annotation['asset_id']
        assert metadata['source_sha256'] == asset['sha256']
        levels[annotation['level']] += 1
        source_labels[record['source_label']] += 1
        same = annotation['asset_id'] == canonical['asset_id']
        if same:
            same_source.append(annotation['id'])
        difference = {field: [canonical[field], annotation[field]]
                      for field in ('quality', 'review_status', 'geometry_intent', 'level')
                      if canonical[field] != annotation[field]}
        if difference:
            status_differences.append({'annotation_id': annotation['id'], 'canonical_id': canonical['id'], 'fields': difference})
        level = annotation['level']
        section = 'motifs' if level in ('figure', 'component') else 'stories' if level in ('scene', 'whole') else 'research'
        url = ('http://127.0.0.1:8030/#section=research&stone=' + annotation['stone_id'] + '&a=' + str(annotation['asset_id']) + '&p=annotate&node=' + str(annotation['id']) + '&scope=core') if section == 'research' else ('http://127.0.0.1:8030/#section=' + section + '&' + ('motif' if section == 'motifs' else 'story') + '=' + str(annotation['id']) + ('&motif_candidates=1' if section == 'motifs' and annotation['review_status'] == 'candidate' else '&story_candidates=1' if section == 'stories' and annotation['review_status'] == 'candidate' else ''))
        filename = asset.get('filename') or asset.get('original_filename') or asset.get('name') or str(annotation['asset_id'])
        version_rows.append({'石号': annotation['stone_id'], '新增标注ID': annotation['id'],
                             '原对象ID': canonical['id'], '来源资产ID': annotation['asset_id'],
                             '来源标签': record['source_label'], '原文件名': filename,
                             '名称': annotation['label'], '级别': level,
                             '范围性质': annotation['geometry_intent'], '质量': annotation['quality'],
                             '研究状态': annotation['review_status'],
                             '本版本引用数': len(refs.get(annotation['id'], [])),
                             '本版本概念关联数': len(concepts.get(annotation['id'], [])),
                             '同原来源精细升级': '是' if same else '否',
                             '查看地址': url, '提案证据': record['proposal']})
    grouped = {}
    for row in version_rows:
        grouped.setdefault(row['石号'], []).append(row)
    stone_rows = []
    for stone in audit['stones']:
        group = '后展厅' if stone['stone_id'] in inventory['layouts']['rear'] else '西长廊' if stone['stone_id'] in inventory['layouts']['xcl'] else '补充范围'
        counts = Counter(row['级别'] for row in grouped.get(stone['stone_id'], []))
        assert sum(counts.values()) == stone['native_versions_written']
        stone_rows.append({'石号': stone['stone_id'], '名称': stone['name'], '范围': group,
                           '源文件数': len(stone['asset_ids']), '不同SHA文件组': stone['different_originals'],
                           '新增配准数': stone['saved_pairs'], '其中局部配准数': stone['local_only_pairs'],
                           '已导入分割版本': stone['native_versions_written'],
                           '人物版本': counts['figure'], '物象版本': counts['component'],
                           '场景版本': counts['scene'], '整体版本': counts['whole'], '分层版本': counts['layer'],
                           '分割来源标签': '；'.join(sorted(set(row['来源标签'] for row in grouped.get(stone['stone_id'], [])))),
                           '已覆盖全部目标': '否（尚无逐石完整验收）'})
    assert len(stone_rows) == 91 and sum(row['已导入分割版本'] for row in stone_rows) == 187
    now = datetime.now(ZoneInfo('Asia/Shanghai')).isoformat(timespec='seconds')
    summary = {'generated_at_china': now, 'audit_generated_at': audit['generated_at'],
               'user_stopped_goal': True, 'scope_complete': False,
               'current_native_decisions_manifest_database_exact': True,
               'counts': {'scope_stones': 91, 'rear': 46, 'west': 40, 'extra': 5, 'source_files': 449,
                          'source_sha_groups': 419, 'new_alignments': 263, 'reviewed_pairs': 271,
                          'local_only_alignments': 7, 'imported_native_versions': 187,
                          'stones_with_native_versions': len(grouped), 'native_levels': dict(levels),
                          'same_source_refinements': len(same_source),
                          'task_new_parent_nodes': 365, 'parent_nodes_without_geometry': 362,
                          'completed_inference_requests': sum(batch['finished_requests'] for batch in audit['batches']),
                          'imported_native_reference_rows': sum(row['本版本引用数'] for row in version_rows),
                          'imported_native_concept_links': sum(row['本版本概念关联数'] for row in version_rows)},
               'original_readonly_checks': original_checks, 'same_source_native_annotation_ids': same_source,
               'current_native_status_differences_from_canonical': status_differences,
               'source_label_counts': dict(source_labels),
               'no_new_source_sha_or_mask_geometry_audit_asserted': True,
               'no_inference_import_original_changes_in_this_report': True}
    DEST.mkdir(parents=True, exist_ok=True)
    assert not (DEST / '停止时只读核验.json').exists(), 'Report exists; do not overwrite it'
    csv_file('逐石成果清单-91件.csv', stone_rows)
    csv_file('已导入分割版本-187份.csv', version_rows)
    (DEST / '停止时只读核验.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
    canvas_data = {'timestamp': now, 'audit_timestamp': audit['generated_at'], 'summary': summary['counts'],
                   'stones': [{'id': row['石号'], 'name': row['名称'], 'area': row['范围'],
                               'assets': row['源文件数'], 'align': row['新增配准数'],
                               'native': row['已导入分割版本'], 'single': row['人物版本'] + row['物象版本'],
                               'scene': row['场景版本'], 'whole': row['整体版本'], 'layer': row['分层版本'],
                               'sources': row['分割来源标签']} for row in stone_rows]}
    (DEST / 'canvas-data.json').write_text(json.dumps(canvas_data, ensure_ascii=False), encoding='utf-8')
    original_ok = ', '.join(f'{value["original_count"]}条{table}' for table, value in original_checks.items())
    report = f'''# 多版本任务停止时的工作汇总与下一步方案

记录时间：{now}（北京时间）。本报告覆盖本聊天的武010样例、叠加修复，以及2026-10-02开始的后展厅/西长廊多版本任务；不把之前152件结构整理、旧版全库切图与文创成果计为本轮新增。

用户已停止长程目标。当前目标查询为空；仍运行的三个子任务已中断，30分钟汇报自动化查询删除结果为“已不存在”。没有继续执行分割、导入或模型推理。成果状态为“执行停止，部分成果已保存”，不是“全部完成”。

## 一、本周期已经落地的工作

### 1. 工作台与版本展示

最初以武梁祠东壁武010作对齐样例，原有4条样例配准保留在起始基线；本轮263条新增配准不包含这些旧样例。随后修复叠加显示及透明度调节，并补充透视配准的透明预览、原图像素矩阵换算和不兼容坐标链隔离。相关实现见AlignSidebar、Viewer2D、geometry和alignment_preview。

为多来源研究结果补充来源按钮、独立透明切图、完整二值掩膜（含孔洞和细线）、原色PNG与出处记录。人物物象及故事库按同一原对象关联不同来源；分层版本由工作台展示。逐例检查实际页面加载、来源切换、标注与引用；这不代表每个按钮对应的所有内部单体都已完成。

### 2. 范围与来源核对

建立后展厅46件、西长廊40件、额外5件的起始清单，合计91件、449份二维资产、419组不同文件SHA。额外5件为武001、武002、武120、武139、武142。

相同SHA文件、同次拍摄转码及不同刻面分别处理。已知同次拍摄分组也不等于已经证实的独立拍摄批次数。原文件没有注明年份或作者时保持未知，不将清单日期当拍摄日期。书页仅有类型参照证据时保留类型参照；不提升候选释读。

### 3. 图像对齐

完成起始1,267次配对计算与最初269条连接的人工复核，后续增加武142限定刻面重算和武078拓片/拓片照片配准。目前已复核271条，正式写入263条新配准、复用1条基线配准；初始6条拒绝以及已解决的旧重算项保留历史。7条新配准只适用于局部，不接入整图传递。

武142重算用画像刻面的独立检验点排除地面错误匹配。武078资产683—684已保存同面配准，682照片仍未可靠接通。斜照、不同刻面或以墙地背景为主的匹配不发布。对齐可用与分割版本是否发布是两个独立条件。

### 4. 已导入分割：187份

最新严格审计时间：{audit['generated_at']}。本报告再次只读核对接受清单、导入清单与SQLite现有版本集合，三者均为187份，覆盖90件：42个人物、29个物象/构件、104个场景、4个整体布局、8个分层画面。{len(same_source)}份属于同一原来源上的精细范围升级，不能当新拍摄批次。

模型批次共完成13,680次请求；该数含重试和多个提示，绝不是13,680份可用分割。2026-10-03既有候选索引涉及1,785个原标注的4,674组来源组合，其中纯SAM3请求为1,729个原标注的4,556组组合；未经本源视觉验收的候选没有计入187份。

已保存版本在其各自原图像素上复核。人物、动物轮廓与场景语义范围分别记录；保留真实刻面磨蚀、裂缝、拓纸白墨和本源残断，不用他源补造缺失。365个新结构父节点中362个没有几何，不能当作362张新增场景切图。

完整结果见同目录“逐石成果清单-91件.csv”和“已导入分割版本-187份.csv”：每份版本列明石号、原对象、新标注、来源资产、来源标签、原文件名、范围、状态、引用和概念数量、查看地址及提案路径。

代表性结果包括：武010齐继母的2024阮浩/2025任超两版；武022、025、044等车骑与仙界场景；武037荆轲刺秦王多来源场景；武039孔门弟子拓片；武047东王公仙界车骑四来源展示；西长廊武086—095的奏乐、车骑和迎谒场景；武024、068的独立分层；武001/002阙身同源精细升级；武120五鱼完整及明确标为局部的来源；武139双龙五璧照片。

### 5. 来源、文献、概念与原始记录

187份几何版本当前有{summary['counts']['imported_native_reference_rows']}条直接引用、{summary['counts']['imported_native_concept_links']}条概念关联，另有父节点及共享描述的关联，这些数量不代表新增学术认定。原对象、来源像素帧、父层级、文段/书图和概念保持可追溯。

本报告逐项只读比较了原始基线：{original_ok}，均无原记录差异。原图不改画；原研究候选和类型参照不能因为分割边界通过就变成确定的历史释读。对新增版本与原对象的质量、状态及范围字段差异另列在“停止时只读核验.json”，历史版本没有在本次报告中被重写。

### 6. README与过程记录

README多版本章节已同步263条新配准、187份分割、来源展示实例、不同范围的含义以及仍未完成的项目。起始基线、备份、每轮提案和验收记录保存在研究目录；逐石审计scope_complete仍为false。

## 二、最后一个阶段做了什么

最近正式新增的是武047的2010拓片和2025任超场景、武024的2010照片第一层，以及武046的2010拓片场景5998。计数从183经185、186达到187。武046完成本源修边、独立第二审、导入、页面来源切换、透明预览和引用/概念检查；保留DOC-001第203页文段、第220页图版9.11以及概念517。该版是场景范围，不是其中所有人物、飞鱼的独立轮廓。

达到187之后，主要工作是武070整石v9的原JPEG、工作图、关键边与全周缘复核，武031完整双菱纹带，以及武053整体纹饰研究。最新计数未再增加。武070v9作者提出可验收建议，但主审/独立复核仍无法确认右上灰褐区域的材料归属，因此未接受、未导入；停止前第二审最终journal尚未提交。武031末次作者消息对2010照片/拓片两源整体带作暂缓判断，但停止前正式最终journal尚未保存；不据消息冒称已完成正式验收。

## 三、为什么后期反复

问题不是批量推理还没有跑完，而是精确边界的人工复核没有明确终止规则。

武070整石连续修订到v9：先后发现底角石唇漏取、侧边背景混入、色卡下浅脊漏取；修正后又遇到右上区域是否属于同石厚边的问题。同一张照片反复放大不能恢复失焦、遮挡或无法辨认的材料身份。

我没有及时把“可以修正的轮廓错误”与“源照片证据不足”分开，也没有给每个对象设置重试上限。少数疑难项目消耗了大量精力；过程记录持续增加，正式成果增长很慢。来源组合的完整范围还没有冻结，反复扫描候选、重读交接和复核旧图进一步放大了这个问题。

精确性要求应通过拒绝不可靠结果实现，不能理解成每张图都必须无限重试直至发布。上述判断是本周期工作方法的复盘，不降低已经保存成果的验收要求。

## 四、停止时的暂缓与未完成项目

- 武070源652整石v9：右上灰褐区域材料身份未确证；原v1—v8及v9候选均不计入187份。
- 武031原对象3070完整双菱纹带：2010照片138/拓片139的中右上下带界磨蚀，与邻层残线混杂；末次作者报告暂缓，0新整体掩膜。
- 武053源288（2024阮浩）整体纹饰3084：下缘石唇、黑影、灰褐底座失焦混色，作者正式暂缓；2025任超源289仅核对同件同面，尚未进行自身完整周缘研究。
- 武078照片682：同面确认，但新配准初稿无可靠检验点通过，不导入；已有683—684配准与分割不重复处理。
- 武037仰卧者的衣摆/框线、武038照片飞鸟的翼与横栏、武068坐者衣袖/榻/云纹、武045照片下层磨蚀横栏、武072/074手足以及武139源346修边稿等，仍为暂缓或未验收候选。
- 武142没有本任务已导入分割版本；其本轮配准、同源转码与书图异面核对已有记录。

按照用户新范围，57个单独或短段垂帐纹/菱纹目标停止独立补版，已保存8份历史单元版和原标注保留。今后只研究本源完整纹带/纹饰，不能合并旧单元掩膜代替整体分割。

187份版本覆盖90件，只证明90件至少有一份结果。全91件、全部449份资产以及人物/物象/场景的全部目标尚未完成逐项验收。历史“222组待补”“188组有年份作者”只来自186版跟踪子集，不是完整剩余量，不能据此推算总体完成率。

## 五、下一步方案（仅规划，不自动启动）

1. 冻结现有成果。本次保留187份、263条以及不可变证据；建立唯一逐石—刻面—来源—对象表。每条只能处于已验收、可处理、证据不足、重复来源、不同刻面或不适用之一。模型文件和修订次数不计成果。
2. 将困难项移出普通队列。武070/031/053/037等固定为“等待新证据”，记录问题坐标和需要的证据。只有新照片、更清楚的原文件或明确的材料/边界判断到来才重开；不会因定时器触发重试。
3. 用5件石头做一个有限试点，建议先从武010、武022、武024、武025、武047选取。开工前列定这5件的全部适用刻面、独立来源和确切对象，优先原图边界清晰的未补组合。批次处理达到12个版本或2小时就结束并交付，无论成功多少；不自动续开。
4. 精度门槛保持不变。每份结果做一次本源全周缘检查及一次独立复核；只有明确可纠正的错误才修一次并复验。仍不确定就暂缓，不增加v3/v4循环，也不把整体偷换成局部。人物动物保持精确单体；纹饰按本源整体。
5. 一次收口四项结果。保存通过版本后统一核对对齐、掩膜、来源/文献/概念、实际页面和README，交付明确的成功/暂缓/不适用清单。需要分割但无可靠配准的来源允许独立作本源分割，分别标记其对齐状态。
6. 最终交付口径为有限清单：所有选定对象都有明确结论，所有可辨认来源结果已验收，不可辨认者列入带理由的保留清单。这叫“本批次交付完成”，不能把暂缓的分割说成成功。每批结束后再由用户决定下一批，停止无限目标和自动唤醒。

此方案尚未执行。无需用户逐条做像素审查；需要用户参与的仅是补充无法从现有源确认的新证据或选择下一批范围。

## 六、核对依据与边界

本报告当前检查：基线原行一致性、正式导入ID集合、来源资产身份和逐石汇总。
既有证据复用：此前187份掩膜与裁剪的严格审计、实际界面截图、来源/概念检查。没有为写报告再次逐像素打开187份图，也没有新增精度测试结论。

本报告输出的CSV采用UTF-8 BOM以便Windows表格软件读取。时间按Asia/Shanghai记录。原始历史提案和审计没有被覆盖。
'''
    (DEST / '全部工作与下一步.md').write_text(report, encoding='utf-8')
    print(json.dumps({'report_dir': str(DEST), 'summary': summary, 'canvas_data_file': str(DEST / 'canvas-data.json')}, ensure_ascii=False))

if __name__ == '__main__':
    main()
