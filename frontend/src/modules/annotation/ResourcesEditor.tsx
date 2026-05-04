import { Download, FileImage, Layers, Plus, RefreshCcw, Sparkles, Trash2, Upload } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  listStoneResources,
  uploadStoneResource,
  type StoneListItem,
  type StoneResourceEntry
} from "../../api/client";
import { generateOrthoImage } from "./orthophoto";
import type { IimlDocument, IimlResourceEntry, IimlResourceTransform } from "./types";

// 资源标签页主面板。做了 4 件事：
//
// 1. 列出 doc.resources（IIML 里挂的逻辑资源条目）
// 2. 列出后端 data/stone-resources/{stoneId}/ 里实际落盘的图像（用户 / 上次
//    正射生成），哪怕还没绑进 IIML 也能看到
// 3. 提供 "从三维模型生成正射图" 按钮：用 Three.js offscreen 渲染器把模型
//    正面拍一张 PNG，POST 到后端落盘，然后自动加到 doc.resources
// 4. 手工添加 IIML resource 条目（补 URI、类型等元数据；用于外链 IIIF / 本地
//    拓片等场景）
//
// 和 v0.7.0 的差别：这里从 "轻量列表" 升级为"真能生成 / 上传 / 消费资源"的
// 工作台，是 M4 多资源版本管理的核心入口。

const resourceTypes = [
  { id: "Mesh3D", label: "3D 模型", description: "OBJ / GLB / GLTF 等三维网格" },
  { id: "OriginalImage", label: "原图", description: "高清照片 / 拓片照片 tif" },
  { id: "Orthophoto", label: "正射图", description: "由三维模型生成的正射投影 PNG（本模块可一键生成）" },
  { id: "Rubbing", label: "拓片", description: "纸质拓片扫描" },
  { id: "NormalMap", label: "法线图", description: "RTI 派生 / 摄影测量出的法线图" },
  { id: "LineDrawing", label: "线图", description: "考古学者绘制 / Canny 派生" },
  { id: "RTI", label: "RTI", description: "Reflectance Transformation Imaging 多光源资源" },
  { id: "PointCloud", label: "点云", description: "PLY / E57 / LAS 三维扫描点云" },
  { id: "Other", label: "其他", description: "自定义资源" }
];

// 正射视图选项（对应 orthophoto.ts 里的 view 字段）
const orthoViewOptions: Array<{ id: "front" | "back" | "top" | "bottom"; label: string }> = [
  { id: "front", label: "正面" },
  { id: "back", label: "背面" },
  { id: "top", label: "顶面" },
  { id: "bottom", label: "底面" }
];

export type ResourcesEditorProps = {
  doc?: IimlDocument;
  stone?: StoneListItem;
  onAddResource: (resource: IimlResourceEntry) => void;
  onUpdateResource: (id: string, patch: Partial<IimlResourceEntry>) => void;
  onDeleteResource: (id: string) => void;
  // 用于向工作区全局状态报消息（走 dispatchAnnotation set-status）
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

  const boundUris = useMemo(() => {
    const set = new Set<string>();
    for (const resource of resources) {
      if (typeof resource.uri === "string") set.add(resource.uri);
    }
    return set;
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
      // 把新资源条目加进 IIML doc.resources，带完整的跨资源坐标变换元数据
      // （I2 v0.8.0：modelBox UV ↔ 正射图 UV 的线性仿射变换信息）
      const resourceId = `resource-ortho-${orthoView}-${Date.now().toString(36)}`;
      onAddResource({
        id: resourceId,
        type: "Orthophoto",
        uri: uploaded.uri,
        description: `从 3D 模型生成的正射图（${orthoViewOptions.find((o) => o.id === orthoView)?.label ?? orthoView}）；像素尺寸 ${result.width}×${result.height}；模型 AABB ${result.modelSize.width.toFixed(2)}×${result.modelSize.height.toFixed(2)}×${result.modelSize.depth.toFixed(2)}`,
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
      onStatusMessage?.(`已生成正射图：${result.width}×${result.height}px，已关联到 IIML resources`);
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
        description: `已存在的落盘资源（${entry.fileName}）`,
        acquiredAt: entry.createdAt ?? new Date().toISOString()
      });
      onStatusMessage?.(`已把 ${entry.fileName} 关联到 IIML resources`);
    },
    [onAddResource, onStatusMessage]
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
    onStatusMessage?.(`已添加资源条目 ${id}`);
  };

  function describeTransform(transform: IimlResourceTransform): string {
    if (transform.kind === "orthographic-from-model") {
      const viewLabel = orthoViewOptions.find((o) => o.id === transform.view)?.label ?? transform.view;
      const equiv = transform.equivalentToModel
        ? "（与 3D 模型 UV 等价，标注自动双向共享）"
        : "";
      return `正射投影 · ${viewLabel} · AABB ${transform.modelAABB.width.toFixed(1)}×${transform.modelAABB.height.toFixed(1)} · frustum ${transform.frustumScale.toFixed(2)}× · 像素 ${transform.pixelSize.width}×${transform.pixelSize.height} ${equiv}`;
    }
    if (transform.kind === "homography-4pt") {
      return `4 点单应性 · ${transform.controlPoints.length} 对对应点`;
    }
    return "3×3 仿射矩阵";
  }

  return (
    <section className="resources-tab">
      <header className="resources-tab-head">
        <div className="resources-tab-title-row">
          <Layers size={16} />
          <h3>资源版本</h3>
          <span className="resources-tab-count">{resources.length} / {serverResources.length}</span>
        </div>
        <p className="resources-tab-hint">
          同一画像石可挂多份资源（原图 / 拓片 / 法线图 / RTI / 点云 / 从模型生成的正射图）。
          <strong>上方列表来自 IIML 文档</strong>（会随 IIML 一起导出）；
          <strong>下方列表是后端 `data/stone-resources/` 实际落盘的文件</strong>（可一键关联到 IIML）。
        </p>
      </header>

      {/* === 正射图生成 === */}
      <section className="resources-tab-section">
        <header className="resources-tab-section-head">
          <Sparkles size={14} />
          <span>从三维模型生成正射图</span>
        </header>
        <p className="resources-tab-section-hint">
          没有原图 / 拓片时，可以用三维模型渲染一张正射 PNG 作为标注底图替代。
          生成后自动落盘到后端 + 关联到 IIML resources，可直接用作 SAM / YOLO /
          标注画布的底图素材。
        </p>
        <div className="resources-ortho-row">
          <div className="resources-ortho-views">
            {orthoViewOptions.map((option) => (
              <button
                key={option.id}
                type="button"
                className={orthoView === option.id ? "resources-ortho-view is-on" : "resources-ortho-view"}
                onClick={() => setOrthoView(option.id)}
                disabled={generating}
                title={`按"${option.label}"方向做正射投影`}
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
            title={
              !stone?.modelUrl
                ? "该画像石没有三维模型"
                : generating
                ? "正在生成中…"
                : "offscreen Three.js 渲染 3072px 长边 PNG，自动存后端 + 关联到 IIML"
            }
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
              title="手工添加资源条目（如外链 IIIF Canvas）"
            >
              <Plus size={12} /> 添加
            </button>
          ) : null}
        </header>

        {resources.length === 0 ? (
          <p className="muted-text">暂无资源条目。点上方"生成正射图"或"添加"。</p>
        ) : (
          <ul className="resources-list">
            {resources.map((resource) => {
              const typeMeta = resourceTypes.find((t) => t.id === resource.type);
              const previewable = typeof resource.uri === "string" && /\.(png|jpe?g|webp|bmp)$/i.test(resource.uri);
              return (
                <li key={resource.id} className="resources-item">
                  <div className="resources-item-head">
                    <span className="resources-item-type">
                      {typeMeta?.label ?? resource.type}
                    </span>
                    <span className="resources-item-id">{resource.id}</span>
                    {previewable ? (
                      <a
                        href={resource.uri}
                        target="_blank"
                        rel="noreferrer"
                        className="mini-icon"
                        title="在新标签页预览图像"
                      >
                        <Download size={13} />
                      </a>
                    ) : null}
                    <button
                      type="button"
                      className="mini-icon danger"
                      onClick={() => onDeleteResource(resource.id)}
                      title="仅从 IIML 条目里删除，不会删后端文件"
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
                  {resource.description ? (
                    <div className="resources-item-desc">{resource.description}</div>
                  ) : null}
                  {resource.transform ? (
                    <div className="resources-item-transform" title="跨资源坐标变换元数据">
                      <strong>坐标变换</strong> · {describeTransform(resource.transform)}
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
                  <option key={t.id} value={t.id} title={t.description}>
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
                placeholder="如 /api/stones/29/rubbing 或 https://museum.org/iiif/29/canvas"
                onChange={(event) => setDraftUri(event.target.value)}
              />
            </label>
            <label className="resources-form-row">
              <span>说明</span>
              <input
                type="text"
                value={draftDescription}
                placeholder="可选：拍摄方式 / 设备 / 采集者"
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
          <span className="muted-text">data/stone-resources/{stoneId}/</span>
          <button
            type="button"
            className="ghost-link"
            onClick={refreshServerResources}
            disabled={refreshing}
            title="重新扫描后端该 stoneId 目录"
          >
            <RefreshCcw size={12} /> 刷新
          </button>
        </header>
        {serverResources.length === 0 ? (
          <p className="muted-text">该画像石后端尚无落盘资源。点"生成正射图"会自动落盘。</p>
        ) : (
          <ul className="resources-list resources-list--server">
            {serverResources.map((entry) => {
              const bound = boundUris.has(entry.uri);
              return (
                <li key={entry.fileName} className="resources-item resources-item--server">
                  <div className="resources-item-head">
                    <span className="resources-item-type">{entry.type}</span>
                    <span className="resources-item-id">{entry.fileName}</span>
                    {bound ? <span className="resources-item-badge">已关联</span> : null}
                    <a
                      href={entry.uri}
                      target="_blank"
                      rel="noreferrer"
                      className="mini-icon"
                      title="在新标签页预览"
                    >
                      <Download size={13} />
                    </a>
                    {!bound ? (
                      <button
                        type="button"
                        className="ghost-link"
                        onClick={() => handleBindServerResource(entry)}
                        title="把该落盘文件关联到 IIML resources[]"
                      >
                        <Plus size={12} /> 关联
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
  // onUpdateResource 当前在 UI 上不暴露 inline 编辑，保留接口供未来扩展
  void onUpdateResource;
}
