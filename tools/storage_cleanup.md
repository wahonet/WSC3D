# 项目体积清理执行手册（2026-10-04）

**状态：档1—6 已于 2026-10-04 23:37 全部完成。** 清理后 93.33 GiB / 30,260 个文件（清理前 177.0 GiB / 94,251）。各档实际：档1 −16.13 GiB / −14,161（`progress.json` 中 tier1 记录的是最后一次补扫 `__pycache__` 的重跑，首轮数字见 `log.jsonl`）；档2 −42.42 GiB / 357 个快照转为资源包条目，0 个跳过；档3 −6.98 GiB / −14,647；档4 −16.19 GiB / −13,350；档5 21,483 个 JSON → 2 个 zip，−1.34 GiB；档6 −0.64 GiB / −3。验证：资源包相关 47 项测试及其余逐文件测试通过；357 个快照全部可解析且 SHA 一致；平台 thumb/preview/work-image/native-frame 接口实测 200。未通过的 6 个测试文件与清理无关（缺 Blender `bpy`、需平台在 8030 运行、缺 `WSC_SAM_RESULT` 环境变量、`core10-candidates.v1.json` 数据与 models 配置的既有问题）。

用户已批准执行档1—6。任何模型接手时：先读本文件，再运行 `python tools/storage_cleanup.py status`（打印当前体积、文件数和 `progress.json` 中每档状态），从第一个未标记 `done` 的档继续。逐步事件日志在 `data/reports/storage-cleanup-20261004/log.jsonl`（`data/` 被 .gitignore 忽略，部分编辑器工具无法直接读取，可用 shell 查看）。

## 背景

清理前：177.0 GiB / 94,248 个文件（基线约 86 GiB / 8,400）。增长来源：
- `resources/stones/*/versions` 研究底图快照 43.5 GiB：`services/resource_versions.py::pin_asset` 整份复制原图；其中 357 个与 `runtime/resource-packs` 中已压缩原图 SHA256 相同。
- `resources/authoring/research` 28.4 GiB / 69,774：AI 分割流程中间产物。
- `tmp` 16.7 GiB / 14,439：临时文件。

判断依据：平台按“原图 + 数据库内嵌 RLE 掩膜（annotations.geometry.native_mask）”实时生成切图与下载 PNG；后端不读取 `resources/authoring/research` 与 `tmp`；数据库对 research 文件的引用仅为出处记录。`versions` 快照会被 `services/resources.py::asset_path` 读取，所以只做“去重”而不是删除。

## 执行方法

所有步骤由 `tools/storage_cleanup.py` 完成，每档都从当前磁盘状态重新规划，中断后直接重跑同一档即可。先停止平台（`tools/停止平台.bat`；确认 8030 端口无监听）。

```
python tools/storage_cleanup.py status
python tools/storage_cleanup.py tier1        # 依次 tier1 … tier6
python tools/storage_cleanup.py rollback-tier2   # 仅在需要撤销档2时
```

| 档 | 内容 | 预计 |
|---|---|---|
| tier1 | 删除 `tmp/` 下除 `wsc-check-backup`（tools/research 会 import 其中 .py）和 `recovery` 外的全部；删除 src/tools/tests/tmp 下 `__pycache__` 与 `.pytest_cache` | 16.1 GiB / ~14,050 |
| tier2 | 对 `versions/` 中与资源包成员 SHA 相同的快照：重算 SHA、核对包成员大小 → 在 `runtime/resource-packs/manifest.json` 增加指向同一成员的条目（每 20 个原子写一次）→ 删除散文件。回滚清单 `tier2-snapshots.jsonl`，原清单备份 `manifest-before-tier2.json` | 42.4 GiB / 357 |
| tier3 | 删除 research 下既不被数据库引用、也不被 README/research 内 md 链接的 PNG/JPG（不含 cutouts/masks）。清单 `tier3-deleted.jsonl` | 7.0 GiB / 14,647 |
| tier4 | 删除 `rear46-execution-20261003/stones/*/object-extraction/{cutouts,masks}/*.png`（未被链接者）。每张 SHA 仍记录在各石 `cutouts.json`。清单 `tier4-deleted.jsonl` | 16.2 GiB / 13,350 |
| tier5 | 两轮 `native-proposals/` 中未被数据库、`native-commits.json`、md 引用的 JSON 打包为 `<run>/native-proposals-unreferenced-N.zip`（逐个 SHA 回读校验后删原件）。成员清单 `tier5-<run>-N-members.jsonl` | ~1.2 GiB / ~21,480 |
| tier6 | 删除 `tmp/recovery/stonelab-after-tests-20260929.db`、`data/backups/alignment-wu010-20261001`、`data/backups/multiversion-20261002`（保留 rear46-execution-20261003 备份） | 0.64 GiB / 3 |

以上清单/日志文件均位于 `data/reports/storage-cleanup-20261004/`。

配套代码修改（随档2一起）：`src/backend/app/resource_archives.py::_cache_path` 改为按包内成员（member）生成缓存路径，使快照条目与原图条目共用同一份解压缓存，避免 C 盘 `%LOCALAPPDATA%\WSC-Unified\cache` 重复解压。原有条目 name 与 member 相同，现有缓存不失效。

## 不动的内容

`runtime/runtime.zip`、`runtime/resource-packs/*.zip`、`models`、`data/stonelab.db`、`data/index`、`resources/stones` 其余内容、research 中全部 JSON/MD/CSV 记录及被引用的证据图、`tmp/wsc-check-backup`、`src`、`tools`、`config`。

## 完成后的验证

1. 回归测试：`python -m pytest tests -q`（系统 Python 缺依赖时用 `%LOCALAPPDATA%\WSC-Unified\environments\<id>` 下的解释器）。
2. 校验档2：对 `tier2-snapshots.jsonl` 抽样调用 `app.resource_paths.resource_exists` 与 `resolve_resource`，确认解压结果 SHA 一致。
3. 启动平台抽查：形象库/故事库来源切换、透明 PNG 下载、图像研究打开带快照的底图。

## 注意

- 档4后若要用 `tools/research` 续做/复核 rear46 一轮，部分审计脚本会打开已删除的 cutout PNG，需先按 `cutouts.json` 重建。
- 档5后续做该轮时，把对应 zip 解压回 run 目录即可（成员路径为 `native-proposals/<文件名>`）。
- README 中提到的 `data/backups/multiversion-20261002/stonelab-before.db` 在档6后不再存在。
