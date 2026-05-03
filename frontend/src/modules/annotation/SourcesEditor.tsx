import { Trash2 } from "lucide-react";
import type { IimlSource, StoneMetadata } from "../../api/client";

type SourcesEditorProps = {
  value?: IimlSource[];
  metadata?: StoneMetadata;
  onChange: (next: IimlSource[]) => void;
};

// tag 上展示的完整语义标签（在每条证据源的头部）
const kindLabels: Record<IimlSource["kind"], string> = {
  metadata: "档案层/帧",
  reference: "文献引用",
  resource: "关联资源",
  other: "其他"
};

// 下方 + 按钮展示的简短标签（4 个按钮一排，越短越好）
const kindButtonLabels: Record<IimlSource["kind"], string> = {
  metadata: "档案",
  reference: "文献",
  resource: "资源",
  other: "其他"
};

export function SourcesEditor({ value, metadata, onChange }: SourcesEditorProps) {
  const sources = value ?? [];

  const update = (index: number, next: IimlSource) => {
    const copy = sources.slice();
    copy[index] = next;
    onChange(copy);
  };

  const remove = (index: number) => {
    onChange(sources.filter((_, pos) => pos !== index));
  };

  const addKind = (kind: IimlSource["kind"]) => {
    let next: IimlSource;
    switch (kind) {
      case "metadata":
        next = { kind: "metadata", layerIndex: metadata?.layers[0]?.layer_index ?? 0 };
        break;
      case "reference":
        next = { kind: "reference", title: "" };
        break;
      case "resource":
        next = { kind: "resource", resourceId: "" };
        break;
      case "other":
        next = { kind: "other", text: "" };
        break;
    }
    onChange([...sources, next]);
  };

  return (
    <div className="sources-editor">
      {sources.length === 0 ? (
        <p className="muted-text small">暂无证据源。可以关联档案层/帧、文献、资源或自由备注。</p>
      ) : (
        <ul className="sources-list">
          {sources.map((source, index) => (
            <SourceRow
              key={index}
              source={source}
              metadata={metadata}
              onChange={(next) => update(index, next)}
              onRemove={() => remove(index)}
            />
          ))}
        </ul>
      )}
      <div className="sources-add">
        {(Object.keys(kindButtonLabels) as IimlSource["kind"][]).map((kind) => (
          <button
            key={kind}
            type="button"
            className="secondary-action small"
            onClick={() => addKind(kind)}
            disabled={kind === "metadata" && !metadata?.layers.length}
            title={kind === "metadata" && !metadata?.layers.length ? "当前画像石未关联结构化档案" : kindLabels[kind]}
          >
            + {kindButtonLabels[kind]}
          </button>
        ))}
      </div>
    </div>
  );
}

function SourceRow({
  source,
  metadata,
  onChange,
  onRemove
}: {
  source: IimlSource;
  metadata?: StoneMetadata;
  onChange: (next: IimlSource) => void;
  onRemove: () => void;
}) {
  return (
    <li className="source-row">
      <div className="source-row-head">
        <span className="source-kind-tag">{kindLabels[source.kind]}</span>
        <button type="button" className="mini-icon danger" title="删除该证据源" onClick={onRemove}>
          <Trash2 size={13} />
        </button>
      </div>
      <div className="source-row-body">
        {source.kind === "metadata" ? (
          <MetadataSource source={source} metadata={metadata} onChange={onChange} />
        ) : source.kind === "reference" ? (
          <ReferenceSource source={source} onChange={onChange} />
        ) : source.kind === "resource" ? (
          <ResourceSource source={source} onChange={onChange} />
        ) : (
          <OtherSource source={source} onChange={onChange} />
        )}
      </div>
    </li>
  );
}

function MetadataSource({
  source,
  metadata,
  onChange
}: {
  source: Extract<IimlSource, { kind: "metadata" }>;
  metadata?: StoneMetadata;
  onChange: (next: IimlSource) => void;
}) {
  const layers = metadata?.layers ?? [];
  const currentLayer = layers.find((layer) => layer.layer_index === source.layerIndex) ?? layers[0];
  const panels = currentLayer?.panels ?? [];

  return (
    <div className="source-form">
      <label>
        <span>层</span>
        <select
          value={source.layerIndex}
          onChange={(event) => onChange({ ...source, layerIndex: Number(event.target.value), panelIndex: undefined })}
        >
          {layers.length === 0 ? <option value={0}>未加载结构化档案</option> : null}
          {layers.map((layer) => (
            <option key={layer.layer_index} value={layer.layer_index}>
              第 {layer.layer_index} 层 · {layer.title || "未命名"}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>帧</span>
        <select
          value={source.panelIndex ?? -1}
          onChange={(event) => {
            const raw = Number(event.target.value);
            onChange({ ...source, panelIndex: raw < 0 ? undefined : raw });
          }}
        >
          <option value={-1}>整层（不选帧）</option>
          {panels.map((panel) => (
            <option key={panel.panel_index} value={panel.panel_index}>
              {panel.panel_index + 1}. {panel.position || "未命名帧"}
            </option>
          ))}
        </select>
      </label>
      <label className="source-span-2">
        <span>备注</span>
        <input
          type="text"
          value={source.note ?? ""}
          placeholder="可填写与该层/帧的关联说明..."
          onChange={(event) => onChange({ ...source, note: event.target.value })}
        />
      </label>
    </div>
  );
}

function ReferenceSource({
  source,
  onChange
}: {
  source: Extract<IimlSource, { kind: "reference" }>;
  onChange: (next: IimlSource) => void;
}) {
  return (
    <div className="source-form">
      <label className="source-span-2">
        <span>题名</span>
        <input
          type="text"
          value={source.title ?? ""}
          placeholder="例：汉画像石综述"
          onChange={(event) => onChange({ ...source, title: event.target.value })}
        />
      </label>
      <label className="source-span-2">
        <span>URI</span>
        <input
          type="url"
          value={source.uri ?? ""}
          placeholder="https:// 或 urn:..."
          onChange={(event) => onChange({ ...source, uri: event.target.value })}
        />
      </label>
      <label className="source-span-2">
        <span>引用</span>
        <input
          type="text"
          value={source.citation ?? ""}
          placeholder="作者. 标题. 出版信息. 页码."
          onChange={(event) => onChange({ ...source, citation: event.target.value })}
        />
      </label>
    </div>
  );
}

function ResourceSource({
  source,
  onChange
}: {
  source: Extract<IimlSource, { kind: "resource" }>;
  onChange: (next: IimlSource) => void;
}) {
  return (
    <div className="source-form">
      <label className="source-span-2">
        <span>资源 ID</span>
        <input
          type="text"
          value={source.resourceId}
          placeholder="例：stone-14:rti"
          onChange={(event) => onChange({ ...source, resourceId: event.target.value })}
        />
      </label>
      <label className="source-span-2">
        <span>备注</span>
        <input
          type="text"
          value={source.note ?? ""}
          placeholder="与该资源的关联说明..."
          onChange={(event) => onChange({ ...source, note: event.target.value })}
        />
      </label>
    </div>
  );
}

function OtherSource({
  source,
  onChange
}: {
  source: Extract<IimlSource, { kind: "other" }>;
  onChange: (next: IimlSource) => void;
}) {
  return (
    <div className="source-form">
      <label className="source-span-2">
        <span>文本</span>
        <textarea
          value={source.text}
          placeholder="自由备注..."
          rows={2}
          onChange={(event) => onChange({ ...source, text: event.target.value })}
        />
      </label>
    </div>
  );
}
