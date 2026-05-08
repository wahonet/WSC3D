/**
 * 关联工作台（顶层 tab，浏览 / 拼接 / 标注 之后）
 *
 * 用户从相机 / 扫描设备拖到 pic/ 的图通常是 `08A0001.tif` 这种相机原始命名，
 * pic.ts / sam.py 按 `^(\d+)` 数字前缀匹配完全无法命中 stone。该工作台让用户
 * 通过缩略图对照一对一关联，并支持双面 / 多面石头（如武氏祠 16、17 号）：
 *
 *  - 左栏：石头列表（带 3D 缩略图 + 已关联状态）
 *  - 中栏：选中石头的"面"列表 — A 面（主面，进入标注 pipeline）+ 可选 B/C/D…
 *    副面（仅留档，不参与 SAM/YOLO）。每个面是一个 slot 按钮：已绑显示缩略图 +
 *    解除；未绑显示"未关联"，配合右栏选图后绑入
 *  - 右栏：pic/ 文件缩略图网格（缩略图来自 ai-service /ai/pic-preview）
 *
 * 关联完成后 backend 把 pic/{原文件名} 重命名为：
 *   - 主面（face=undefined）：`{N}{cleanName}{ext}`（向后兼容）
 *   - 副面（face="B"…）：`{N}-{F}{cleanName}{ext}`
 * 之后切到"标注" tab，主面会被 ai-service `_find_source_image` 识别加载。
 */

import { useEffect, useMemo, useState } from "react";
import {
  bindPicToStone,
  fetchPicList,
  picPreviewUrl,
  unbindPicFromStone,
  type PicBinding,
  type PicListEntry,
  type PicListResponse,
  type StoneListItem
} from "../../api/client";
import { formatFaceLabel } from "../shared/pic-face";
import { StoneViewer } from "../viewer/StoneViewer";

type Props = {
  active: boolean;
  stones: StoneListItem[];
  /** 与外层下拉同步：用户在外面选了 stone，进绑定页直接定位 */
  selectedStoneId?: string;
  onSelectStone: (id: string) => void;
  /** 关联成功后让父组件刷新 catalog / 标注模块 */
  onChanged?: () => void;
};

const ERROR_HINTS: Record<string, string> = {
  "file-not-found": "源文件不存在（可能已被改名 / 删除），刷新列表后重试",
  "target-exists": "目标文件名已被占用，请先取消该石头当前的关联",
  "numeric-key-conflict": "该石头编号在 pic/ 已有同号文件，请先取消其关联或处理冲突",
  "already-bound": "该石头此面已经关联了图片，先取消再重绑",
  "stone-not-found": "石头不存在",
  "missing-params": "缺少参数",
  "not-bound": "该石头此面当前没有关联",
  "file-missing": "当前关联的文件已不在 pic/ 中（已自动清理记录）",
  "invalid-face": "面标识非法（仅允许 B-Z 单字母作为副面）"
};

/**
 * face slot：固定 A 面（主面，"" 表示）+ B 面（副面）。
 * 双面石头是当前数据集已知的最大复杂度（武氏祠 16、17 号）。如果将来出现
 * 三面以上的石头，再扩容到 ["", "B", "C"] 即可。
 */
const ALL_FACE_SLOTS = ["", "B"] as const;

function describeError(error: string, detail?: string): string {
  const hint = ERROR_HINTS[error] ?? `未知错误（${error}）`;
  return detail ? `${hint}：${detail}` : hint;
}

function formatSize(bytes: number): string {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function BindingWorkspace({
  active,
  stones,
  selectedStoneId,
  onSelectStone,
  onChanged
}: Props) {
  const [data, setData] = useState<PicListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [selectedFileName, setSelectedFileName] = useState<string>("");
  const [selectedFace, setSelectedFace] = useState<string>("");
  const [filter, setFilter] = useState<"all" | "unbound" | "bound">("unbound");
  const [stoneFilter, setStoneFilter] = useState<"all" | "withoutPic" | "withPic">("withoutPic");

  const reload = async () => {
    setLoading(true);
    setError("");
    try {
      const list = await fetchPicList();
      setData(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  // 进入 tab 时（含从其它 tab 切回）刷新一次；非 active 时不轮询
  useEffect(() => {
    if (active) {
      void reload();
      setStatus("");
    }
  }, [active]);

  const stoneById = useMemo(() => new Map(stones.map((s) => [s.id, s])), [stones]);
  // "已关联"判定：只要有任意面（主面 / 副面）已绑就算
  const boundStoneIds = useMemo(
    () => new Set((data?.bindings ?? []).map((b) => b.stoneId)),
    [data]
  );

  const visibleStones = useMemo(() => {
    if (stoneFilter === "withPic") return stones.filter((s) => boundStoneIds.has(s.id));
    if (stoneFilter === "withoutPic") return stones.filter((s) => !boundStoneIds.has(s.id));
    return stones;
  }, [stones, stoneFilter, boundStoneIds]);

  const visibleFiles: PicListEntry[] = useMemo(() => {
    const list = data?.files ?? [];
    if (filter === "unbound") return list.filter((f) => !f.isBound);
    if (filter === "bound") return list.filter((f) => f.isBound);
    return list;
  }, [data, filter]);

  const selectedStone = selectedStoneId ? stoneById.get(selectedStoneId) : undefined;
  const selectedFile = useMemo(
    () => (data?.files ?? []).find((f) => f.fileName === selectedFileName),
    [data, selectedFileName]
  );

  // 当前选中 stone 的所有 binding（按 face 升序）
  const stoneBindings: PicBinding[] = useMemo(() => {
    if (!selectedStone) return [];
    return (data?.bindings ?? [])
      .filter((b) => b.stoneId === selectedStone.id)
      .sort((a, b) => (a.face ?? "").localeCompare(b.face ?? ""));
  }, [data, selectedStone]);

  const usedFaces = useMemo(
    () => new Set(stoneBindings.map((b) => b.face ?? "")),
    [stoneBindings]
  );

  // 始终展示 A 面 + B 面两个 slot（数据集最大复杂度）
  const faceSlots = ALL_FACE_SLOTS;

  // 切换 stone 时 reset selectedFace：优先选第一个未绑面，全绑则选 A 面
  useEffect(() => {
    if (!selectedStone) {
      setSelectedFace("");
      return;
    }
    const firstEmpty = ALL_FACE_SLOTS.find((f) => !usedFaces.has(f));
    setSelectedFace(firstEmpty ?? "");
  }, [selectedStoneId, data?.bindings.length]);

  // 当前选中面的 binding（若有）
  const selectedFaceBinding = useMemo(
    () => stoneBindings.find((b) => (b.face ?? "") === selectedFace),
    [stoneBindings, selectedFace]
  );

  const canBind =
    selectedStone &&
    selectedFile &&
    !selectedFile.isBound &&
    !selectedFaceBinding;

  const handleBind = async () => {
    if (!selectedStone || !selectedFile) return;
    setBusy(true);
    setError("");
    const faceForUI = formatFaceLabel(selectedFace);
    setStatus(`正在关联 ${selectedStone.id} 的${faceForUI}…`);
    try {
      const r = await bindPicToStone(selectedStone.id, selectedFile.fileName, selectedFace || undefined);
      if (!r.ok) {
        setError(describeError(r.error, r.detail));
        setStatus("");
      } else {
        setStatus(
          `已关联 ${r.binding.stoneId} ${formatFaceLabel(r.binding.face)} ← ${r.binding.originalFileName} → ${r.binding.currentFileName}`
        );
        setSelectedFileName("");
        await reload();
        onChanged?.();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("");
    } finally {
      setBusy(false);
    }
  };

  const handleUnbind = async (stoneId: string, face: string) => {
    setBusy(true);
    setError("");
    setStatus(`正在取消 ${stoneId} 的${formatFaceLabel(face)}关联…`);
    try {
      const r = await unbindPicFromStone(stoneId, face || undefined);
      if (!r.ok) {
        setError(describeError(r.error, r.detail));
        setStatus("");
      } else {
        setStatus(`已取消${formatFaceLabel(face)}关联，文件还原为 ${r.restoredFileName}`);
        await reload();
        onChanged?.();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("");
    } finally {
      setBusy(false);
    }
  };


  return (
    <div className="binding-workspace" aria-label="图片关联工作台">
      <header className="binding-header">
        <div>
          <h2>关联</h2>
          <p className="binding-sub">
            {data?.exists === false
              ? "pic/ 目录不存在；先把图片放进 pic/ 再来这里关联。"
              : `pic/ 共 ${data?.files.length ?? 0} 个文件 · 已关联 ${
                  data?.bindings.length ?? 0
                } / ${stones.length} 块石头`}
          </p>
        </div>
        <div className="binding-header-actions">
          <button type="button" onClick={() => void reload()} disabled={loading || busy}>
            刷新
          </button>
        </div>
      </header>

      {(status || error) && (
        <div className={`binding-status ${error ? "is-error" : ""}`}>{error || status}</div>
      )}

      <div className="binding-body">
        {/* 左栏：石头列表 */}
        <section className="binding-stones">
          <header>
            <h3>石头</h3>
            <select
              value={stoneFilter}
              onChange={(e) => setStoneFilter(e.target.value as typeof stoneFilter)}
            >
              <option value="withoutPic">未关联（{stones.length - boundStoneIds.size}）</option>
              <option value="withPic">已关联（{boundStoneIds.size}）</option>
              <option value="all">全部（{stones.length}）</option>
            </select>
          </header>
          <ul>
            {visibleStones.map((s) => {
              const isSelected = selectedStoneId === s.id;
              const isBound = boundStoneIds.has(s.id);
              return (
                <li
                  key={s.id}
                  className={isSelected ? "is-selected" : ""}
                  onClick={() => onSelectStone(s.id)}
                >
                  <div className="binding-stone-thumb">
                    {s.thumbnailUrl ? (
                      <img src={s.thumbnailUrl} alt={s.displayName} loading="lazy" />
                    ) : s.referenceThumbnailUrl ? (
                      <img
                        src={s.referenceThumbnailUrl}
                        alt={`${s.displayName}（参考）`}
                        loading="lazy"
                        className="is-reference"
                        title="参考图：temp/ 中同编号文件，subject 可能与本石头描述不一致"
                      />
                    ) : (
                      <span className="binding-stone-thumb-placeholder">无 3D 缩略图</span>
                    )}
                  </div>
                  <div className="binding-stone-meta">
                    <div className="binding-stone-id">
                      {s.id}
                      <span className={`binding-dot ${isBound ? "is-on" : ""}`}>
                        {isBound ? "✓" : "○"}
                      </span>
                    </div>
                    <div className="binding-stone-name">{s.displayName}</div>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>

        {/* 中栏：选中详情 + 面 slot 列表 */}
        <section className="binding-detail">
          <h3>当前选中</h3>
          {selectedStone ? (
            <div className="binding-detail-card">
              <div className="binding-detail-thumb">
                <StoneViewer
                  key={selectedStone.id}
                  active={active}
                  stone={selectedStone}
                  viewMode="3d"
                  background="black"
                  hideHud
                />
              </div>
              <div className="binding-detail-info">
                <div className="binding-detail-id">{selectedStone.id}</div>
                <div className="binding-detail-name">{selectedStone.displayName}</div>
              </div>

              {/* 面 slot 列表：A 面（主面，进标注 pipeline）+ B/C/D… 副面 */}
              <div className="binding-face-list" role="tablist" aria-label="面选择">
                {faceSlots.map((face) => {
                  const binding = stoneBindings.find((b) => (b.face ?? "") === face);
                  const isSelected = selectedFace === face;
                  return (
                    <button
                      key={face || "primary"}
                      type="button"
                      role="tab"
                      aria-selected={isSelected}
                      className={`binding-face-slot ${isSelected ? "is-selected" : ""} ${
                        binding ? "is-bound" : "is-empty"
                      }`}
                      onClick={() => setSelectedFace(face)}
                    >
                      <span className="binding-face-label">
                        {formatFaceLabel(face)}
                        {!face && <em className="binding-face-tag">主面</em>}
                      </span>
                      {binding ? (
                        <img
                          src={picPreviewUrl(binding.currentFileName, 200)}
                          alt={formatFaceLabel(face)}
                          loading="lazy"
                        />
                      ) : (
                        <span className="binding-face-empty">未关联</span>
                      )}
                    </button>
                  );
                })}
              </div>

              {/* 选中面的状态 + 操作 */}
              {selectedFaceBinding ? (
                <div className="binding-detail-bound">
                  <div className="binding-detail-label">
                    {formatFaceLabel(selectedFace)}已关联
                    {!selectedFace && <em className="binding-face-tag-inline">（主面，进入标注）</em>}
                  </div>
                  <div className="binding-detail-thumb-preview">
                    <img
                      src={picPreviewUrl(selectedFaceBinding.currentFileName, 480)}
                      alt={selectedFaceBinding.currentFileName}
                      loading="lazy"
                    />
                  </div>
                  <code>{selectedFaceBinding.currentFileName}</code>
                  <div className="binding-detail-meta">
                    原始：<span>{selectedFaceBinding.originalFileName}</span>
                  </div>
                  <button
                    type="button"
                    className="binding-unbind"
                    onClick={() =>
                      void handleUnbind(selectedStone.id, selectedFaceBinding.face ?? "")
                    }
                    disabled={busy}
                  >
                    取消{formatFaceLabel(selectedFace)}关联
                  </button>
                </div>
              ) : selectedFile && !selectedFile.isBound ? (
                <div className="binding-bind-row">
                  <div className="binding-detail-label">
                    将关联到 {formatFaceLabel(selectedFace)}
                    {!selectedFace && <em className="binding-face-tag-inline">（主面）</em>}
                  </div>
                  <div className="binding-detail-thumb-preview">
                    <img
                      src={picPreviewUrl(selectedFile.fileName, 480)}
                      alt={selectedFile.fileName}
                      loading="lazy"
                    />
                  </div>
                  <code>{selectedFile.fileName}</code>
                  <button type="button" onClick={() => void handleBind()} disabled={busy || !canBind}>
                    关联到 {formatFaceLabel(selectedFace)}
                  </button>
                </div>
              ) : (
                null
              )}
            </div>
          ) : (
            <div className="binding-hint">从左侧选一块石头，开始关联</div>
          )}
        </section>

        {/* 右栏：图片文件缩略图网格 */}
        <section className="binding-files">
          <header>
            <h3>图片</h3>
            <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
              <option value="unbound">
                未关联（{(data?.files ?? []).filter((f) => !f.isBound).length}）
              </option>
              <option value="bound">
                已关联（{(data?.files ?? []).filter((f) => f.isBound).length}）
              </option>
              <option value="all">全部（{data?.files.length ?? 0}）</option>
            </select>
          </header>
          <div className="binding-grid">
            {loading && <div className="binding-hint">加载中…</div>}
            {!loading && visibleFiles.length === 0 && (
              <div className="binding-hint">没有匹配的文件</div>
            )}
              {visibleFiles.map((file) => {
                const stone = file.boundStoneId ? stoneById.get(file.boundStoneId) : undefined;
                const isSelected = selectedFileName === file.fileName;
                return (
                  <button
                    key={file.fileName}
                    type="button"
                    className={`binding-card ${isSelected ? "is-selected" : ""} ${
                      file.isBound ? "is-bound" : ""
                    }`}
                    onClick={() => {
                      setSelectedFileName(file.fileName);
                      // 已绑文件：联动选中其 stone + face，中栏直接定位到该面
                      if (file.boundStoneId) {
                        onSelectStone(file.boundStoneId);
                        setSelectedFace(file.boundFace ?? "");
                      }
                    }}
                    title={file.fileName}
                  >
                  <div className="binding-thumb">
                    <img
                      src={picPreviewUrl(file.fileName, 320)}
                      alt={file.fileName}
                      loading="eager"
                      onError={(e) => {
                        (e.currentTarget as HTMLImageElement).style.display = "none";
                      }}
                    />
                    <span className="binding-thumb-fallback">正在生成缩略图</span>
                  </div>
                  <div className="binding-card-name">{file.fileName}</div>
                  <div className="binding-card-meta">
                    <span>{formatSize(file.size)}</span>
                    {file.numericKey && <span>#{file.numericKey}</span>}
                  </div>
                  {file.isBound && stone && (
                    <div className="binding-card-bound">
                      → {stone.id} {file.boundFace ? `(${file.boundFace})` : ""} {stone.displayName.slice(0, 12)}
                    </div>
                  )}
                  {!file.isBound && file.face && (
                    <div className="binding-card-face">{file.face} 面（孤儿副面）</div>
                  )}
                </button>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
