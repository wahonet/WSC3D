import cytoscape from "cytoscape";
import type { Core, EdgeDefinition, ElementDefinition, NodeDefinition } from "cytoscape";
import { useEffect, useMemo, useRef, useState } from "react";
import type { IimlAnnotation, IimlDocument, IimlRelation, IimlRelationOrigin, IimlStructuralLevel } from "./types";
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

// 关系类别（kind）按 4 组归类，用于 chip 过滤；与 RelationsEditor 词表保持一致
const kindGroups: Array<{ id: "narrative" | "hierarchy" | "spatial" | "interpret"; label: string }> = [
  { id: "narrative", label: "叙事" },
  { id: "hierarchy", label: "层级" },
  { id: "spatial", label: "空间" },
  { id: "interpret", label: "解释" }
];

const originLabels: Record<IimlRelationOrigin, string> = {
  manual: "人工",
  "spatial-auto": "自动",
  "ai-suggest": "AI"
};

// D2 layout 选项；cose 力导向（精确但慢）/ concentric（按 degree 同心圆）
// / breadthfirst（关系树）/ grid（栅格，最快，> 100 节点推荐）
type LayoutName = "cose" | "concentric" | "breadthfirst" | "grid";

const layoutOptions: Array<{ id: LayoutName; label: string; hint: string }> = [
  { id: "cose", label: "力导向", hint: "精确但耗时；适合 < 100 节点" },
  { id: "concentric", label: "同心圆", hint: "按关系数量分层；中心是关系最多的标注" },
  { id: "breadthfirst", label: "层级树", hint: "按关系展开为层级树，适合层级关系多的图" },
  { id: "grid", label: "栅格", hint: "最快；适合 > 100 节点" }
];

function buildLayoutOptions(name: LayoutName): cytoscape.LayoutOptions {
  const base = { fit: true, padding: 24, animate: false } as const;
  switch (name) {
    case "concentric":
      return {
        ...base,
        name: "concentric",
        // 度数越高（关系越多）越靠中心
        concentric: (node: cytoscape.NodeSingular) => node.degree(false),
        levelWidth: () => 1,
        minNodeSpacing: 20
      } as cytoscape.LayoutOptions;
    case "breadthfirst":
      return {
        ...base,
        name: "breadthfirst",
        directed: true,
        spacingFactor: 1.2
      } as cytoscape.LayoutOptions;
    case "grid":
      return {
        ...base,
        name: "grid",
        avoidOverlap: true,
        condense: false
      } as cytoscape.LayoutOptions;
    case "cose":
    default:
      return {
        ...base,
        name: "cose",
        idealEdgeLength: 80,
        nodeOverlap: 12,
        refresh: 20,
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
      } as cytoscape.LayoutOptions;
  }
}

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

  // D1 关系筛选：kind 组 + origin 各自 toggle；空集合 = 不过滤
  const [activeKindGroups, setActiveKindGroups] = useState<Set<string>>(new Set());
  const [activeOrigins, setActiveOrigins] = useState<Set<IimlRelationOrigin>>(new Set());
  // D2 大图性能：layout 选项；节点数 > 100 时默认 grid（cose 慢）
  const annotationCountForLayout = doc?.annotations.length ?? 0;
  const defaultLayout: LayoutName = annotationCountForLayout > 100 ? "grid" : "cose";
  const [layoutName, setLayoutName] = useState<LayoutName>(defaultLayout);
  // doc 量级在 100 左右切换时需要把 layoutName 重置为推荐值，避免用户被卡在
  // 不合适的 layout 上；用 useEffect 监听数量级跳变
  useEffect(() => {
    setLayoutName(annotationCountForLayout > 100 ? "grid" : "cose");
  }, [annotationCountForLayout]);

  const toggleKindGroup = (group: string) => {
    setActiveKindGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  };
  const toggleOrigin = (origin: IimlRelationOrigin) => {
    setActiveOrigins((prev) => {
      const next = new Set(prev);
      if (next.has(origin)) next.delete(origin);
      else next.add(origin);
      return next;
    });
  };
  const clearFilters = () => {
    setActiveKindGroups(new Set());
    setActiveOrigins(new Set());
  };

  // doc 中实际存在的 origin 类型，避免 chip 显示空"AI"等无意义选项
  const usedOrigins = useMemo(() => {
    const set = new Set<IimlRelationOrigin>();
    for (const relation of relations) {
      set.add(relation.origin);
    }
    return set;
  }, [relations]);

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

    // 先算度数（每个 annotation 涉及的关系数），让节点 data.degree 可被
    // mapData() 引用（D2 节点 size 视觉化"叙事中心"）
    const degreeMap = new Map<string, number>();
    for (const annotation of doc.annotations) {
      degreeMap.set(annotation.id, 0);
    }
    for (const relation of relations) {
      degreeMap.set(relation.source, (degreeMap.get(relation.source) ?? 0) + 1);
      degreeMap.set(relation.target, (degreeMap.get(relation.target) ?? 0) + 1);
    }

    for (const annotation of doc.annotations) {
      annotationIds.add(annotation.id);
      const node: NodeDefinition = {
        group: "nodes",
        data: {
          id: annotation.id,
          label: annotation.label || "未命名",
          level: annotation.structuralLevel,
          color: structuralLevelColors[annotation.structuralLevel] ?? "#6f6a62",
          degree: degreeMap.get(annotation.id) ?? 0
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
          isAuto: relation.origin !== "manual",
          // D1 过滤需要：把 kind 与 origin 写进 data，运行时按 chip 刷 .is-faded
          kind: relation.kind,
          origin: relation.origin
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
            // D2 节点 size 按度数：关系越多、节点越大；放大基数 22，每多 1 度
            // 加 4px，封顶 50。让"叙事中心"在视觉上一眼可见
            width: ("mapData(degree, 0, 12, 22, 50)" as unknown) as number,
            height: ("mapData(degree, 0, 12, 22, 50)" as unknown) as number,
            "border-width": 1.5,
            "border-color": "#1d1a18"
          }
        },
        {
          selector: "node.is-selected",
          style: {
            "border-color": "#f3a712",
            "border-width": 3
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
        },
        {
          // D1 过滤：被 chip 排除的边淡化（保持空间不变，便于回切对比）
          selector: "edge.is-faded",
          style: {
            opacity: 0.12,
            width: 1
          }
        }
      ],
      // D2 layout 由当前 layoutName 决定；> 100 节点默认 grid 避免 cose 卡
      layout: buildLayoutOptions(layoutName),
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
    // layoutName 故意不进依赖：layout 切换走 handleLayoutChange 直接 cy.layout().run()，
    // 不重建图。重建图只发生在内容变化时，初始化时拿当时的 layoutName 即可。
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // D1 关系过滤：根据 activeKindGroups / activeOrigins 给不匹配的边打
  // .is-faded class 淡化（而不是隐藏，保持空间布局稳定，便于回切对比）
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) {
      return;
    }
    const hasKindFilter = activeKindGroups.size > 0;
    const hasOriginFilter = activeOrigins.size > 0;
    cy.batch(() => {
      cy.edges().removeClass("is-faded");
      if (!hasKindFilter && !hasOriginFilter) {
        return;
      }
      cy.edges().forEach((edge) => {
        const kind = edge.data("kind") as string | undefined;
        const origin = edge.data("origin") as IimlRelationOrigin | undefined;
        const group = kind ? kindToGroup[kind] : undefined;
        const kindOk = !hasKindFilter || (group !== undefined && activeKindGroups.has(group));
        const originOk = !hasOriginFilter || (origin !== undefined && activeOrigins.has(origin));
        if (!(kindOk && originOk)) {
          edge.addClass("is-faded");
        }
      });
    });
  }, [activeKindGroups, activeOrigins, annotationsKey, relationsKey]);

  const handleRelayout = () => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.layout(buildLayoutOptions(layoutName)).run();
  };

  const handleLayoutChange = (next: LayoutName) => {
    setLayoutName(next);
    const cy = cyRef.current;
    if (!cy) return;
    cy.layout(buildLayoutOptions(next)).run();
  };

  const handleFit = () => {
    cyRef.current?.fit(undefined, 24);
  };

  const annotationCount = doc?.annotations.length ?? 0;
  const filterActive = activeKindGroups.size > 0 || activeOrigins.size > 0;

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
      <div className="knowledge-graph-filters" role="group" aria-label="布局">
        <span className="knowledge-graph-filter-label">布局：</span>
        {layoutOptions.map((option) => (
          <button
            key={option.id}
            type="button"
            className={
              layoutName === option.id
                ? "knowledge-graph-chip is-on"
                : "knowledge-graph-chip"
            }
            onClick={() => handleLayoutChange(option.id)}
            title={option.hint}
          >
            {option.label}
          </button>
        ))}
      </div>
      {relations.length > 0 ? (
        <div className="knowledge-graph-filters" role="group" aria-label="关系筛选">
          <span className="knowledge-graph-filter-label">类别：</span>
          {kindGroups.map((group) => (
            <button
              key={group.id}
              type="button"
              className={
                activeKindGroups.has(group.id)
                  ? "knowledge-graph-chip is-on"
                  : "knowledge-graph-chip"
              }
              onClick={() => toggleKindGroup(group.id)}
              title={`仅高亮"${group.label}"组的关系，其他淡化`}
            >
              {group.label}
            </button>
          ))}
          {usedOrigins.size > 1 ? (
            <>
              <span className="knowledge-graph-filter-label">来源：</span>
              {(Array.from(usedOrigins) as IimlRelationOrigin[]).map((origin) => (
                <button
                  key={origin}
                  type="button"
                  className={
                    activeOrigins.has(origin)
                      ? "knowledge-graph-chip is-on"
                      : "knowledge-graph-chip"
                  }
                  onClick={() => toggleOrigin(origin)}
                  title={`仅高亮 origin = ${origin} 的关系`}
                >
                  {originLabels[origin] ?? origin}
                </button>
              ))}
            </>
          ) : null}
          {filterActive ? (
            <button type="button" className="ghost-link" onClick={clearFilters}>
              清除过滤
            </button>
          ) : null}
        </div>
      ) : null}
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
