import { Layers, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import type { IimlDocument, IimlResourceEntry } from "./types";

// G1：多资源版本切换 — 轻量版
//
// IIML schema 已经支持 `resources: Array<...>`，但 v0.6.0 之前 UI 上只默认一份
// `Mesh3D` 资源（`{stoneId}:model` URI = /api/stones/{id}/model），用户没法管理。
//
// 这个组件挂在标注模式右侧面板（独立 tab 或在 list tab 顶部），让用户：
//   - 列出当前 doc.resources
//   - 添加新 resource：type（Mesh3D / OriginalImage / Rubbing / NormalMap /
//     LineDrawing / RTI / PointCloud / Other）+ uri + 描述
//   - 删除 / 编辑现有 resource
//
// **画布暂不会自动渲染新 resource**（M4 第二阶段做"画布资源选择 UI" + 按
// resource 加载图像）；当前阶段只让 metadata 可见 + 可管理，annotation
// 创建时仍走默认 resourceId。
//
// 这样 .hpsml / IIML / IIIF 导出都能带完整资源元数据，与外部博物馆平台
// 互操作时多源可见。

const resourceTypes = [
  { id: "Mesh3D", label: "3D 模型", description: "OBJ / GLB / GLTF 等三维网格" },
  { id: "OriginalImage", label: "原图", description: "高清照片 / 拓片照片 tif" },
  { id: "Rubbing", label: "拓片", description: "纸质拓片扫描" },
  { id: "NormalMap", label: "法线图", description: "RTI 派生 / 摄影测量出的法线图" },
  { id: "LineDrawing", label: "线图", description: "考古学者绘制 / Canny 派生" },
  { id: "RTI", label: "RTI", description: "Reflectance Transformation Imaging 多光源资源" },
  { id: "PointCloud", label: "点云", description: "PLY / E57 / LAS 三维扫描点云" },
  { id: "Other", label: "其他", description: "自定义资源" }
];

export type ResourcesEditorProps = {
  doc?: IimlDocument;
  onAddResource: (resource: IimlResourceEntry) => void;
  onUpdateResource: (id: string, patch: Partial<IimlResourceEntry>) => void;
  onDeleteResource: (id: string) => void;
};

export function ResourcesEditor({
  doc,
  onAddResource,
  onUpdateResource,
  onDeleteResource
}: ResourcesEditorProps) {
  const resources = (doc?.resources ?? []) as IimlResourceEntry[];
  const [adding, setAdding] = useState(false);
  const [draftType, setDraftType] = useState("OriginalImage");
  const [draftUri, setDraftUri] = useState("");
  const [draftDescription, setDraftDescription] = useState("");

  const handleSubmit = () => {
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
  };

  return (
    <section className="resources-editor">
      <header className="resources-editor-head">
        <Layers size={14} />
        <span>资源版本</span>
        <span className="resources-editor-count">{resources.length}</span>
        {!adding ? (
          <button
            type="button"
            className="ghost-link"
            onClick={() => setAdding(true)}
            title="添加新的资源版本（如拓片 / RTI / 法线图）"
          >
            <Plus size={12} /> 添加
          </button>
        ) : null}
      </header>
      <p className="resources-editor-hint">
        同一画像石可挂多份资源（原图 / 拓片 / 法线图 / RTI / 点云）。导出
        IIIF / .hpsml 时全部带出。<strong>当前画布仍按 3D 模型 / 高清图 双源显示</strong>，
        其他资源类型仅作元数据归档（M4 后续做画布资源切换）。
      </p>

      {resources.length === 0 ? (
        <p className="muted-text">暂无资源条目。</p>
      ) : (
        <ul className="resources-editor-list">
          {resources.map((resource) => {
            const typeMeta = resourceTypes.find((t) => t.id === resource.type);
            return (
              <li key={resource.id} className="resources-editor-item">
                <div className="resources-editor-item-head">
                  <span className="resources-editor-item-type">
                    {typeMeta?.label ?? resource.type}
                  </span>
                  <span className="resources-editor-item-id">{resource.id}</span>
                  <button
                    type="button"
                    className="mini-icon danger"
                    onClick={() => onDeleteResource(resource.id)}
                    title="删除该资源条目（不会删原文件）"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
                <div className="resources-editor-item-uri" title={resource.uri}>
                  {resource.uri}
                </div>
                {resource.description ? (
                  <div className="resources-editor-item-desc">{resource.description}</div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {adding ? (
        <div className="resources-editor-form">
          <label className="resources-editor-form-row">
            <span>类型</span>
            <select value={draftType} onChange={(event) => setDraftType(event.target.value)}>
              {resourceTypes.map((t) => (
                <option key={t.id} value={t.id} title={t.description}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <label className="resources-editor-form-row">
            <span>URI</span>
            <input
              type="text"
              value={draftUri}
              placeholder="如 /api/stones/29/rubbing 或 https://museum.org/iiif/29/canvas"
              onChange={(event) => setDraftUri(event.target.value)}
            />
          </label>
          <label className="resources-editor-form-row">
            <span>说明</span>
            <input
              type="text"
              value={draftDescription}
              placeholder="可选：拍摄方式 / 设备 / 采集者"
              onChange={(event) => setDraftDescription(event.target.value)}
            />
          </label>
          <div className="resources-editor-form-actions">
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
              onClick={handleSubmit}
              disabled={!draftUri.trim()}
            >
              添加
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
  // onUpdateResource 暂不需要在 v0.7.0 暴露 inline 编辑（创建已支持完整字段），
  // 用作未来扩展点（如标注画布按 resource 切换时记录"上一次活动 resourceId"等）
  void onUpdateResource;
}
