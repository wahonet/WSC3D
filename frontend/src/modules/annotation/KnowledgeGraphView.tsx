import cytoscape from "cytoscape";
import type { Core, EdgeDefinition, ElementDefinition, NodeDefinition } from "cytoscape";
import { useEffect, useRef } from "react";
import type { IimlAnnotation, IimlDocument, IimlRelation, IimlStructuralLevel } from "./types";
import { relationKindOptions } from "./RelationsEditor";

// 按结构层级着色（与 EditTab 的 structuralLevel 选项呼应；颜色取自 styles 调色板）
const structuralLevelColors: Record<IimlStructuralLevel, string> = {
  whole: "#a3a3a3",
  scene: "#f3a712",
  figure: "#2ec4b6",
  component: "#3a86ff",
  trace: "#c084fc",
  inscription: "#ff5f57",
  damage: "#facc15",
  unknown: "#6f6a62"
};

// 关系按类别分组着色，便于一眼区分边的语义
const kindGroupColors: Record<"narrative" | "hierarchy" | "spatial" | "interpret", string> = {
  narrative: "#f3a712", // 叙事 = 橙
  hierarchy: "#2ec4b6", // 层级 = 青
  spatial: "#a9a096",   // 空间 = 灰
  interpret: "#c084fc"  // 解释 = 紫
};

const kindToGroup: Record<string, "narrative" | "hierarchy" | "spatial" | "interpret"> =
  Object.fromEntries(
    relationKindOptions.map((option) => [option.value, option.group])
  );

type KnowledgeGraphViewProps = {
  doc?: IimlDocument;
  relations: IimlRelation[];
  selectedAnnotationId?: string;
  onSelectAnnotation: (id?: string) => void;
};

/**
 * 知识图谱 tab：用 Cytoscape.js 渲染 annotations + relations 的节点-边图。
 *
 * 设计选择：
 * - 直接用 cytoscape 而不是 react-cytoscapejs：后者在 React 19 上有兼容
 *   报告，且我们对生命周期有完全的控制需求（doc 大改时清空重建）
 * - 只在 doc.annotations / relations 内容变化时重建图，selectedAnnotation
 *   变化只刷高亮、不重建（避免 layout 抖动）
 * - 默认 cose 力导向布局；提供"重新布局"按钮
 *
 * 双向联动：
 * - 外部 selectedAnnotationId 变化 → 给对应节点加 .is-selected class
 * - 用户在图上点节点 → onSelectAnnotation(id) 让画布同步选中
 */
export function KnowledgeGraphView({
  doc,
  relations,
  selectedAnnotationId,
  onSelectAnnotation
}: KnowledgeGraphViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Core | null>(null);
  // 用 ref 持有 onSelect，使 cy 监听器拿到最新值，不需要每次 doc 变化都
  // teardown / re-add 监听器。
  const onSelectRef = useRef(onSelectAnnotation);
  useEffect(() => {
    onSelectRef.current = onSelectAnnotation;
  }, [onSelectAnnotation]);

  // 元素列表的稳定 key —— 用 annotation id + relation id 做内容指纹；
  // 对内容相同的 doc / relations 不重建图，只刷高亮。
  const annotationsKey = doc?.annotations
    .map((annotation) => `${annotation.id}:${annotation.label ?? ""}:${annotation.structuralLevel}`)
    .join("|");
  const relationsKey = relations
    .map((relation) => `${relation.id}:${relation.kind}:${relation.source}->${relation.target}`)
    .join("|");

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    if (!doc) {
      // 还没 load 文档：销毁可能存在的旧实例
      if (cyRef.current) {
        cyRef.current.destroy();
        cyRef.current = null;
      }
      return;
    }

    const elements: ElementDefinition[] = [];
    const annotationIds = new Set<string>();

    for (const annotation of doc.annotations) {
      annotationIds.add(annotation.id);
      const node: NodeDefinition = {
        group: "nodes",
        data: {
          id: annotation.id,
          label: annotation.label || "未命名",
          level: annotation.structuralLevel,
          color: structuralLevelColors[annotation.structuralLevel] ?? "#6f6a62"
        }
      };
      elements.push(node);
    }

    for (const relation of relations) {
      // 边两端必须都是已知 annotation；防御历史 doc 里悬空的 source/target
      if (!annotationIds.has(relation.source) || !annotationIds.has(relation.target)) {
        continue;
      }
      const group = kindToGroup[relation.kind] ?? "interpret";
      const edge: EdgeDefinition = {
        group: "edges",
        data: {
          id: relation.id,
          source: relation.source,
          target: relation.target,
          label: kindLabelOf(relation.kind),
          color: kindGroupColors[group],
          isAuto: relation.origin !== "manual"
        }
      };
      elements.push(edge);
    }

    // 保留先前实例的 layout 状态：仅在内容差异时重建
    if (cyRef.current) {
      cyRef.current.destroy();
      cyRef.current = null;
    }

    const cy = cytoscape({
      container,
      elements,
      style: [
        {
          selector: "node",
          style: {
            "background-color": "data(color)",
            label: "data(label)",
            color: "#f4ece0",
            "font-size": 11,
            "text-valign": "bottom",
            "text-halign": "center",
            "text-margin-y": 4,
            "text-outline-color": "#1d1a18",
            "text-outline-width": 2,
            width: 22,
            height: 22,
            "border-width": 1.5,
            "border-color": "#1d1a18"
          }
        },
        {
          selector: "node.is-selected",
          style: {
            "border-color": "#f3a712",
            "border-width": 3,
            width: 28,
            height: 28
          }
        },
        {
          selector: "edge",
          style: {
            width: 1.6,
            "curve-style": "bezier",
            "line-color": "data(color)",
            "target-arrow-color": "data(color)",
            "target-arrow-shape": "triangle",
            "arrow-scale": 0.9,
            label: "data(label)",
            "font-size": 9,
            color: "#a9a096",
            "text-rotation": "autorotate" as unknown as number,
            "text-background-color": "#1d1a18",
            "text-background-opacity": 0.7,
            "text-background-padding": "1"
          }
        },
        {
          selector: "edge[?isAuto]",
          style: {
            "line-style": "dashed",
            opacity: 0.7
          }
        },
        {
          selector: "edge.is-incident",
          style: {
            width: 2.4,
            opacity: 1
          }
        }
      ],
      layout: {
        name: "cose",
        // 调小 idealEdgeLength 让节点更紧凑；汉画像石标注通常 < 50 个，密集
        // 显示比稀松好看。
        idealEdgeLength: 80,
        nodeOverlap: 12,
        refresh: 20,
        fit: true,
        padding: 24,
        randomize: false,
        componentSpacing: 80,
        nodeRepulsion: 320000,
        edgeElasticity: 80,
        nestingFactor: 1.2,
        gravity: 1,
        numIter: 800,
        initialTemp: 200,
        coolingFactor: 0.95,
        minTemp: 1.0
      } as cytoscape.LayoutOptions,
      wheelSensitivity: 0.3,
      minZoom: 0.2,
      maxZoom: 2.5
    });

    cy.on("tap", "node", (event) => {
      const id = event.target.id() as string;
      onSelectRef.current?.(id);
    });
    cy.on("tap", (event) => {
      // 点空白 = 取消选中（与画布 deselect 一致）
      if (event.target === cy) {
        onSelectRef.current?.(undefined);
      }
    });

    cyRef.current = cy;
    return () => {
      cy.destroy();
      if (cyRef.current === cy) {
        cyRef.current = null;
      }
    };
  }, [annotationsKey, relationsKey, doc]);

  // 仅刷高亮，不重建图：避免每次外部 selectedAnnotationId 变化都导致 layout
  // 抖动重排。
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) {
      return;
    }
    cy.batch(() => {
      cy.elements().removeClass("is-selected").removeClass("is-incident");
      if (selectedAnnotationId) {
        const node = cy.getElementById(selectedAnnotationId);
        if (node && node.length > 0) {
          node.addClass("is-selected");
          node.connectedEdges().addClass("is-incident");
        }
      }
    });
  }, [selectedAnnotationId]);

  const handleRelayout = () => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.layout({
      name: "cose",
      fit: true,
      padding: 24,
      randomize: true
    } as cytoscape.LayoutOptions).run();
  };

  const handleFit = () => {
    cyRef.current?.fit(undefined, 24);
  };

  const annotationCount = doc?.annotations.length ?? 0;

  return (
    <div className="knowledge-graph-tab">
      <div className="knowledge-graph-toolbar">
        <span className="muted-text">
          节点 {annotationCount} · 边 {relations.length}
        </span>
        <button type="button" className="ghost-link" onClick={handleFit}>
          适应窗口
        </button>
        <button type="button" className="ghost-link" onClick={handleRelayout}>
          重新布局
        </button>
      </div>
      {annotationCount === 0 ? (
        <p className="annotation-empty">暂无标注，无法渲染图谱。</p>
      ) : (
        <div ref={containerRef} className="knowledge-graph-canvas" />
      )}
    </div>
  );
}

function kindLabelOf(kind: string): string {
  return relationKindOptions.find((option) => option.value === kind)?.label ?? kind;
}
