/**
 * 资源 tab 主面板 `ResourcesEditor`
 *
 * 标注 panel 的"资源"tab（v0.8.0 H2 从 ListTab 拆分独立），整合了一块画像石
 * 的全部图像类资源管理：
 *
 * 三个 section：
 * 1. **从三维模型生成正射图**：4 个方向（正 / 背 / 顶 / 底）+ 一键生成 PNG，
 *    自动落盘到 `data/stone-resources/{stoneId}/` 并加进 IIML resources[]
 * 2. **IIML 资源条目**：列出 `doc.resources[]`，每条支持预览图像、删除、新
 *    标签页打开；"添加"按钮手工注册外链资源（如 IIIF URI）
 * 3. **后端已落盘**：列出 `data/stone-resources/{stoneId}/` 下实际存在的文件；
 *    未关联到 IIML 的可一键关联，正射图可单独删除（其它类型只允许从 IIML 移除
 *    条目，不删后端文件，避免误删原始素材）
 *
 * 设计要点：
 * - 删除一份后端正射图时同步清理 IIML 里指向同一 URI 的条目，避免悬空链接
 * - 资源 type 与 IIML schema 的 resource type 严格对齐（Mesh3D / OriginalImage /
 *   Orthophoto / Rubbing / NormalMap / LineDrawing / RTI / PointCloud / Other）
 * - 文件名约定：`{type}-{ISO timestamp}.png`，前端按前缀短标签化展示
 *   （如 `orthofront-2024…` → "正射·正"）
 */

import { Download, FileImage, Layers, Plus, RefreshCcw, Sparkles, Trash2, Upload } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  deleteStoneResource,
  listStoneResources,
  uploadStoneResource,
  type StoneListItem,
  type StoneResourceEntry
} from "../../api/client";
import { generateOrthoImage } from "./orthophoto";
import type { IimlDocument, IimlResourceEntry, IimlResourceTransform } from "./types";

const resourceTypes = [
  { id: "Mesh3D", label: "3D 模型" },
  { id: "OriginalImage", label: "原图" },
  { id: "Orthophoto", label: "正射图" },
  { id: "Rubbing", label: "拓片" },
  { id: "NormalMap", label: "法线图" },
  { id: "LineDrawing", label: "线图" },
  { id: "RTI", label: "RTI" },
  { id: "PointCloud", label: "点云" },
  { id: "Other", label: "其他" }
];

const orthoViewOptions: Array<{ id: "front" | "back" | "top" | "bottom"; label: string }> = [
  { id: "front", label: "正面" },
  { id: "back", label: "背面" },
  { id: "top", label: "顶面" },
  { id: "bottom", label: "底面" }
];

// 把后端落盘文件名里的 type 前缀（orthofront / orthoback…）映射成短标签
function shortTypeLabel(type: string): string {
  const lower = type.toLowerCase();
  if (lower === "orthofront") return "正射·正";
  if (lower === "orthoback") return "正射·背";
  if (lower === "orthotop") return "正射·顶";
  if (lower === "orthobottom") return "正射·底";
  if (lower.startsWith("ortho")) return "正射";
  return type;
}

// IIML 里 transform 字段渲染成短标签：避免每条目下挂一长串技术参数
function describeTransformShort(transform: IimlResourceTransform): string {
  if (transform.kind === "orthographic-from-model") {
    const viewLabel = orthoViewOptions.find((o) => o.id === transform.view)?.label ?? transform.view;
    return `正射 · ${viewLabel} · ${transform.pixelSize.width}×${transform.pixelSize.height}`;
  }
  if (transform.kind === "homography-4pt") {
    return `单应性 · ${transform.controlPoints.length} 点`;
  }
  return "仿射矩阵";
}

export type ResourcesEditorProps = {
  doc?: IimlDocument;
  stone?: StoneListItem;
  onAddResource: (resource: IimlResourceEntry) => void;
  onUpdateResource: (id: string, patch: Partial<IimlResourceEntry>) => void;
  onDeleteResource: (id: string) => void;
  onStatusMessage?: (status: string) => void;
};

export function ResourcesEditor({
  doc,
  stone,
  onAddResource,
  onUpdateResource,
  onDeleteResource,
  onStatusMessage
}: ResourcesEditorProps) {
  const resources = (doc?.resources ?? []) as IimlResourceEntry[];
  const stoneId = stone?.id;

  const [adding, setAdding] = useState(false);
  const [draftType, setDraftType] = useState("OriginalImage");
  const [draftUri, setDraftUri] = useState("");
  const [draftDescription, setDraftDescription] = useState("");

  const [orthoView, setOrthoView] = useState<"front" | "back" | "top" | "bottom">("front");
  const [generating, setGenerating] = useState(false);
  const [serverResources, setServerResources] = useState<StoneResourceEntry[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [deletingFileName, setDeletingFileName] = useState<string | null>(null);

  // uri → IIML resource.id 列表（删后端文件时同步清理所有指向它的 IIML 条目，
  // 避免悬空链接；理论上一份文件只会被关联一次，但保留多对一兜底）
  const iimlResourceIdsByUri = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const resource of resources) {
      if (typeof resource.uri !== "string") continue;
      const ids = map.get(resource.uri);
      if (ids) ids.push(resource.id);
      else map.set(resource.uri, [resource.id]);
    }
    return map;
  }, [resources]);

  const refreshServerResources = useCallback(async () => {
    if (!stoneId) return;
    setRefreshing(true);
    try {
      const list = await listStoneResources(stoneId);
      setServerResources(list);
    } finally {
      setRefreshing(false);
    }
  }, [stoneId]);

  useEffect(() => {
    refreshServerResources();
  }, [refreshServerResources]);

  const handleGenerateOrtho = useCallback(async () => {
    if (!stone || !stoneId || !stone.modelUrl) {
      onStatusMessage?.("生成正射图失败：该画像石没有三维模型");
      return;
    }
    setGenerating(true);
    onStatusMessage?.(`从三维模型生成正射图（${orthoViewOptions.find((o) => o.id === orthoView)?.label ?? orthoView}）…`);
    try {
      const result = await generateOrthoImage(stone.modelUrl, {
        view: orthoView,
        maxEdge: 3072,
        background: "light"
      });
      const uploaded = await uploadStoneResource(stoneId, result.blob, {
        type: `ortho-${orthoView}`
      });
      const resourceId = `resource-ortho-${orthoView}-${Date.now().toString(36)}`;
      onAddResource({
        id: resourceId,
        type: "Orthophoto",
        uri: uploaded.uri,
        description: `正射图（${orthoViewOptions.find((o) => o.id === orthoView)?.label ?? orthoView}） ${result.width}×${result.height}`,
        acquisition: "offscreen-three-ortho",
        acquiredAt: new Date().toISOString(),
        transform: {
          kind: "orthographic-from-model",
          view: result.view,
          modelAABB: result.modelSize,
          pixelSize: { width: result.width, height: result.height },
          frustumScale: result.frustumScale,
          equivalentToModel: result.equivalentToModel,
          generatedAt: new Date().toISOString()
        }
      });
      await refreshServerResources();
      onStatusMessage?.(`已生成正射图：${result.width}×${result.height}px`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      onStatusMessage?.(`生成正射图失败：${message}`);
    } finally {
      setGenerating(false);
    }
  }, [stone, stoneId, orthoView, onAddResource, onStatusMessage, refreshServerResources]);

  const handleBindServerResource = useCallback(
    (entry: StoneResourceEntry) => {
      const resourceId = `resource-${entry.type}-${Date.now().toString(36)}`;
      const typeLabel = entry.type.startsWith("ortho") ? "Orthophoto" : "Other";
      onAddResource({
        id: resourceId,
        type: typeLabel,
        uri: entry.uri,
        description: entry.fileName,
        acquiredAt: entry.createdAt ?? new Date().toISOString()
      });
      onStatusMessage?.(`已关联 ${entry.fileName} 到 IIML`);
    },
    [onAddResource, onStatusMessage]
  );

  const handleDeleteServerResource = useCallback(
    async (entry: StoneResourceEntry) => {
      if (!stoneId) return;
      if (!entry.type.toLowerCase().startsWith("ortho")) return;
      const confirmed = window.confirm(`确定删除该正射图吗？\n${entry.fileName}\n（不可撤销）`);
      if (!confirmed) return;
      setDeletingFileName(entry.fileName);
      try {
        // 同步清理 IIML 里指向同一 URI 的条目，避免悬空链接
        const boundIds = iimlResourceIdsByUri.get(entry.uri) ?? [];
        for (const id of boundIds) onDeleteResource(id);
        await deleteStoneResource(stoneId, entry.fileName);
        await refreshServerResources();
        onStatusMessage?.(`已删除正射图 ${entry.fileName}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        onStatusMessage?.(`删除失败：${message}`);
      } finally {
        setDeletingFileName(null);
      }
    },
    [stoneId, iimlResourceIdsByUri, onDeleteResource, onStatusMessage, refreshServerResources]
  );

  const handleSubmitAdd = () => {
    if (!draftUri.trim()) return;
    const id = `resource-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    onAddResource({
      id,
      type: draftType,
      uri: draftUri.trim(),
      description: draftDescription.trim() || undefined,
      acquiredAt: new Date().toISOString()
    });
    setAdding(false);
    setDraftType("OriginalImage");
    setDraftUri("");
    setDraftDescription("");
    onStatusMessage?.(`已添加资源 ${id}`);
  };

  return (
    <section className="resources-tab">
      <header className="resources-tab-head">
        <div className="resources-tab-title-row">
          <Layers size={16} />
          <h3>资源</h3>
          <span
            className="resources-tab-count"
            title="左：IIML 条目数 / 右：后端落盘数"
          >
            {resources.length} / {serverResources.length}
          </span>
        </div>
      </header>

      {/* === 正射图生成 === */}
      <section className="resources-tab-section">
        <header className="resources-tab-section-head">
          <Sparkles size={14} />
          <span>从三维模型生成正射图</span>
        </header>
        <div className="resources-ortho-row">
          <div className="resources-ortho-views">
            {orthoViewOptions.map((option) => (
              <button
                key={option.id}
                type="button"
                className={orthoView === option.id ? "resources-ortho-view is-on" : "resources-ortho-view"}
                onClick={() => setOrthoView(option.id)}
                disabled={generating}
              >
                {option.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="primary-action"
            onClick={handleGenerateOrtho}
            disabled={generating || !stone?.modelUrl}
            title={!stone?.modelUrl ? "该画像石没有三维模型" : "渲染并落盘正射 PNG"}
          >
            <Sparkles size={13} />
            {generating ? "生成中…" : "生成正射图"}
          </button>
        </div>
      </section>

      {/* === IIML resources 列表 === */}
      <section className="resources-tab-section">
        <header className="resources-tab-section-head">
          <FileImage size={14} />
          <span>IIML 资源条目</span>
          {!adding ? (
            <button
              type="button"
              className="ghost-link"
              onClick={() => setAdding(true)}
              title="手工添加资源条目（如外链 IIIF）"
            >
              <Plus size={12} /> 添加
            </button>
          ) : null}
        </header>

        {resources.length === 0 ? (
          <p className="muted-text">暂无</p>
        ) : (
          <ul className="resources-list">
            {resources.map((resource) => {
              const typeMeta = resourceTypes.find((t) => t.id === resource.type);
              const previewable = typeof resource.uri === "string" && /\.(png|jpe?g|webp|bmp)$/i.test(resource.uri);
              return (
                <li key={resource.id} className="resources-item">
                  <div className="resources-item-head">
                    <span className="resources-item-type">{typeMeta?.label ?? resource.type}</span>
                    <span className="resources-item-id" title={resource.id}>{resource.id}</span>
                    {previewable ? (
                      <a
                        href={resource.uri}
                        target="_blank"
                        rel="noreferrer"
                        className="mini-icon"
                        title="新标签页预览"
                      >
                        <Download size={13} />
                      </a>
                    ) : null}
                    <button
                      type="button"
                      className="mini-icon danger"
                      onClick={() => onDeleteResource(resource.id)}
                      title="从 IIML 移除该条目（不删后端文件）"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                  {previewable ? (
                    <img
                      src={resource.uri}
                      alt={resource.description ?? resource.id}
                      className="resources-item-thumb"
                      loading="lazy"
                    />
                  ) : null}
                  <div className="resources-item-uri" title={resource.uri}>
                    {resource.uri}
                  </div>
                  {resource.transform ? (
                    <div className="resources-item-transform">
                      {describeTransformShort(resource.transform)}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}

        {adding ? (
          <div className="resources-form">
            <label className="resources-form-row">
              <span>类型</span>
              <select value={draftType} onChange={(event) => setDraftType(event.target.value)}>
                {resourceTypes.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="resources-form-row">
              <span>URI</span>
              <input
                type="text"
                value={draftUri}
                placeholder="如 /api/stones/29/rubbing"
                onChange={(event) => setDraftUri(event.target.value)}
              />
            </label>
            <label className="resources-form-row">
              <span>说明</span>
              <input
                type="text"
                value={draftDescription}
                placeholder="可选"
                onChange={(event) => setDraftDescription(event.target.value)}
              />
            </label>
            <div className="resources-form-actions">
              <button
                type="button"
                className="secondary-action small"
                onClick={() => {
                  setAdding(false);
                  setDraftUri("");
                  setDraftDescription("");
                }}
              >
                取消
              </button>
              <button
                type="button"
                className="primary-action small"
                onClick={handleSubmitAdd}
                disabled={!draftUri.trim()}
              >
                添加
              </button>
            </div>
          </div>
        ) : null}
      </section>

      {/* === 后端落盘资源列表 === */}
      <section className="resources-tab-section">
        <header className="resources-tab-section-head">
          <Upload size={14} />
          <span>后端已落盘</span>
          <button
            type="button"
            className="ghost-link"
            onClick={refreshServerResources}
            disabled={refreshing}
            title="重新扫描后端目录"
          >
            <RefreshCcw size={12} /> 刷新
          </button>
        </header>
        {serverResources.length === 0 ? (
          <p className="muted-text">暂无</p>
        ) : (
          <ul className="resources-list resources-list--server">
            {serverResources.map((entry) => {
              const bound = iimlResourceIdsByUri.has(entry.uri);
              const isOrtho = entry.type.toLowerCase().startsWith("ortho");
              const isDeleting = deletingFileName === entry.fileName;
              return (
                <li key={entry.fileName} className="resources-item resources-item--server">
                  <div className="resources-item-head">
                    <span className="resources-item-type">{shortTypeLabel(entry.type)}</span>
                    {bound ? <span className="resources-item-badge">已关联</span> : null}
                    <a
                      href={entry.uri}
                      target="_blank"
                      rel="noreferrer"
                      className="mini-icon"
                      title="新标签页预览"
                    >
                      <Download size={13} />
                    </a>
                    {!bound ? (
                      <button
                        type="button"
                        className="ghost-link small"
                        onClick={() => handleBindServerResource(entry)}
                        title="关联到 IIML"
                      >
                        <Plus size={12} /> 关联
                      </button>
                    ) : null}
                    {isOrtho ? (
                      <button
                        type="button"
                        className="mini-icon danger"
                        onClick={() => handleDeleteServerResource(entry)}
                        disabled={isDeleting}
                        title="删除该正射图（不可撤销）"
                      >
                        <Trash2 size={13} />
                      </button>
                    ) : null}
                  </div>
                  <img
                    src={entry.uri}
                    alt={entry.fileName}
                    className="resources-item-thumb"
                    loading="lazy"
                  />
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </section>
  );
  // 当前面板未使用 onUpdateResource（资源条目的字段编辑暂没有专用 UI），
  // 通过 void 标记接口仍然保留，留待未来扩展（如改 description / type）。
  void onUpdateResource;
}
