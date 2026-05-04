/**
 * 知识图谱视图 `KnowledgeGraphView`
 *
 * 标注 panel 里的"图谱"tab，把 IIML 的 annotations + relations 渲染成一张
 * cytoscape 图，帮研究者从"叙事拓扑"视角观察画像石画面：哪些对象互相联结、
 * 谁是构图重心、是否有清晰的叙事簇。
 *
 * 主要功能：
 * - **节点与边**：每条 annotation 是节点（颜色 / 形状按 structuralLevel），
 *   每条 relation 是边（颜色 / 线型按 kind 分组）
 * - **布局**：5 种内置（concentric / cose / breadthfirst / circle / grid），
 *   切换无重置缩放
 * - **着色**：5 种着色方案（结构层级 / 中心性 / 群组 / 关系来源 / 关系类别）
 * - **中心性**：4 种中心性算法（PageRank / Degree / Betweenness / Closeness），
 *   计算 top-N 后给金色光环 + 排行榜横向滚动
 * - **群组检测**：MCL（Markov Clustering）算法，把强连通子图自动着色分组
 * - **筛选**：关系类别 chip + 关系来源 chip 多选，过滤画布与排行榜
 *
 * 设计要点：
 * - cytoscape 实例懒创建一次，元素增量更新（add / remove / update）
 * - 中心性 / 群组结果缓存到 Map，doc / relations 不变时跳过重算
 * - 排行榜放 canvas 下方横向滚动（v0.8.0 H1 修缮），不再挤压 canvas 宽度
 *
 * 参考：见 `graphMetrics.ts` 顶部的 Freeman / Brin & Page / Newman 文献清单
 */

import cytoscape from "cytoscape";
import type { Core, EdgeDefinition, ElementDefinition, NodeDefinition } from "cytoscape";
import { Crown, Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IimlAnnotation, IimlDocument, IimlRelation, IimlRelationOrigin, IimlStructuralLevel } from "./types";
import { relationKindOptions } from "./RelationsEditor";
import {
  centralityKindHints,
  centralityKindLabels,
  clusterColors,
  computeCentrality,
  detectClusters,
  type CentralityKind,
  type CentralityResult
} from "./graphMetrics";

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
// / breadthfirst（关系树）/ grid（栅格，最快，> 100 节点推荐）/ E 阶段加 cluster（按群组聚拢）
type LayoutName = "cose" | "concentric" | "breadthfirst" | "grid" | "cluster";

const layoutOptions: Array<{ id: LayoutName; label: string; hint: string }> = [
  { id: "cose", label: "力导向", hint: "精确但耗时；适合 < 100 节点" },
  { id: "concentric", label: "中心圆", hint: "按 PageRank / 度数把核心节点放最里圈，外圈是边缘节点" },
  { id: "breadthfirst", label: "层级树", hint: "按关系展开为层级树，适合层级关系多的图" },
  { id: "cluster", label: "群组聚拢", hint: "按 MCL 群组分块布局，同簇节点抱团（论文式叙事簇可视化）" },
  { id: "grid", label: "栅格", hint: "最快；适合 > 100 节点" }
];

// 节点 / 边视觉模式
type NodeColorMode = "level" | "cluster" | "centrality";
const nodeColorModeOptions: Array<{ id: NodeColorMode; label: string; hint: string }> = [
  { id: "level", label: "按层级", hint: "按结构层级着色（whole/scene/figure/...）" },
  { id: "cluster", label: "按群组", hint: "按 MCL 群组聚类着色，最大簇是金色（叙事核心）" },
  { id: "centrality", label: "按中心度", hint: "按当前选中的中心性算法着色（深色 = 高分）" }
];

const centralityKinds: CentralityKind[] = ["pageRank", "degree", "betweenness", "closeness"];

function buildLayoutOptions(name: LayoutName, clusterOf?: Map<string, number>): cytoscape.LayoutOptions {
  const base = { fit: true, padding: 24, animate: false } as const;
  switch (name) {
    case "concentric":
      return {
        ...base,
        name: "concentric",
        // 度数越高（关系越多）越靠中心
        concentric: (node: cytoscape.NodeSingular) => {
          const centrality = node.data("centrality") as number | undefined;
          if (typeof centrality === "number") {
            // centrality 是 [0, 1] 浮点；放大成"圈索引"避免 levelWidth 把所有节点挤一圈
            return Math.round(centrality * 50);
          }
          return node.degree(false);
        },
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
    case "cluster":
      // 群组聚拢：用 cose 但通过 nodeRepulsion 函数让同簇内排斥小、跨簇排斥大
      return {
        ...base,
        name: "cose",
        idealEdgeLength: ((edge: cytoscape.EdgeSingular) => {
          const a = clusterOf?.get(edge.source().id());
          const b = clusterOf?.get(edge.target().id());
          return a !== undefined && b !== undefined && a === b ? 50 : 220;
        }) as unknown as number,
        nodeRepulsion: ((node: cytoscape.NodeSingular) => {
          const cluster = clusterOf?.get(node.id());
          return cluster === 0 ? 600000 : 280000;
        }) as unknown as number,
        nodeOverlap: 16,
        randomize: false,
        componentSpacing: 120,
        edgeElasticity: 60,
        nestingFactor: 1.2,
        gravity: 0.6,
        numIter: 1200,
        initialTemp: 220,
        coolingFactor: 0.95,
        minTemp: 1.0
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
 * v0.7.0 增强（图谱完善）：
 * - **中心性识别**：4 种算法（PageRank / Degree / Betweenness / Closeness），
 *   实时计算并标识"叙事核心"节点（金色光环 + 王冠图标）
 * - **群组检测**：MCL 算法自动找叙事簇，最大簇着金色 = "构图核心"
 * - **节点着色 3 模式**：按层级 / 按群组 / 按中心度
 * - **侧栏排行榜**：top-5 关键节点列表，点击跳转选中
 * - **群组聚拢布局**：同簇节点抱团，跨簇节点拉远，论文式叙事簇可视化
 *
 * 设计选择：
 * - 直接用 cytoscape 而不是 react-cytoscapejs：后者在 React 19 上有兼容
 *   报告，且对生命周期需要完全控制
 * - 中心性 / 群组在 doc 内容指纹变化时重算，不是每次 render 算
 * - 着色 / 排行榜变化只刷 cy.style + 局部 React 重渲染，不重建图
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

  // E1 / E2 视觉模式
  const [colorMode, setColorMode] = useState<NodeColorMode>("level");
  const [centralityKind, setCentralityKind] = useState<CentralityKind>("pageRank");
  // 是否在画面上高亮"中心节点"（top-N 金色光环 + ★ 标识）
  const [highlightCentral, setHighlightCentral] = useState(true);
  // 侧栏排行榜是否展开（移动端 / 小屏可手动折叠）
  const [rankingPanelOpen, setRankingPanelOpen] = useState(true);

  // 中心性 / 群组结果（由 cy 重建后按需重算）
  const [centrality, setCentrality] = useState<CentralityResult | null>(null);
  const [clusterOf, setClusterOf] = useState<Map<string, number>>(new Map());
  const [clusterSizes, setClusterSizes] = useState<number[]>([]);

  // doc 量级在 100 左右切换时需要把 layoutName 重置为推荐值
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

  // 元素列表的稳定 key —— 用 annotation id + relation id 做内容指纹
  const annotationsKey = doc?.annotations
    .map((annotation) => `${annotation.id}:${annotation.label ?? ""}:${annotation.structuralLevel}`)
    .join("|");
  const relationsKey = relations
    .map((relation) => `${relation.id}:${relation.kind}:${relation.source}->${relation.target}`)
    .join("|");

  // ============================================================
  //  cy 实例创建 / 销毁
  // ============================================================
  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    if (!doc) {
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
          degree: degreeMap.get(annotation.id) ?? 0,
          // centrality / clusterColor 在 cy 创建后由 useEffect 写入；这里先占位
          centrality: 0,
          clusterColor: "#6f6a62",
          centralityColor: "#6f6a62"
        }
      };
      elements.push(node);
    }

    for (const relation of relations) {
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
          kind: relation.kind,
          origin: relation.origin
        }
      };
      elements.push(edge);
    }

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
            // 着色模式由 colorMode 决定，统一从 data(currentColor) 读
            "background-color": "data(currentColor)",
            label: "data(label)",
            color: "#f4ece0",
            "font-size": 11,
            "text-valign": "bottom",
            "text-halign": "center",
            "text-margin-y": 4,
            "text-outline-color": "#1d1a18",
            "text-outline-width": 2,
            // 节点 size 按 centrality（如果有）；fallback 用 degree
            // mapData(centrality, 0, 1, 22, 56) — 高中心度节点显著放大
            width: ("mapData(centrality, 0, 1, 22, 56)" as unknown) as number,
            height: ("mapData(centrality, 0, 1, 22, 56)" as unknown) as number,
            "border-width": 1.5,
            "border-color": "#1d1a18"
          }
        },
        {
          selector: "node.is-central",
          // 中心节点：金色光环 + 加粗描边；shadow-* 在 Cytoscape 类型里不全，
          // 用 as 断言绕过即可
          style: ({
            "border-color": "#f3a712",
            "border-width": 4,
            "shadow-blur": 18,
            "shadow-color": "#f3a712",
            "shadow-opacity": 0.85,
            "shadow-offset-x": 0,
            "shadow-offset-y": 0
          } as unknown) as cytoscape.Css.Node
        },
        {
          selector: "node.is-selected",
          style: {
            "border-color": "#ff5f57",
            "border-width": 4
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
          selector: "edge.is-faded",
          style: {
            opacity: 0.12,
            width: 1
          }
        }
      ],
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
    // layoutName / colorMode / centralityKind 等故意不进依赖：它们只刷视觉，不重建图
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [annotationsKey, relationsKey, doc]);

  // ============================================================
  //  中心性 / 群组重算（doc 变化时）
  // ============================================================
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || cy.nodes().length === 0) {
      setCentrality(null);
      setClusterOf(new Map());
      setClusterSizes([]);
      return;
    }
    const result = computeCentrality(cy, centralityKind, { topN: 5 });
    setCentrality(result);
    const clusters = detectClusters(cy);
    setClusterOf(clusters.clusterOf);
    setClusterSizes(clusters.clusterSizes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [annotationsKey, relationsKey, centralityKind]);

  // ============================================================
  //  视觉模式（colorMode + centrality + cluster）写入 node data
  // ============================================================
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const scoreMap = new Map<string, number>();
    if (centrality) {
      centrality.scores.forEach((s) => scoreMap.set(s.id, s.normalized));
    }
    cy.batch(() => {
      cy.nodes().forEach((node) => {
        const id = node.id();
        const norm = scoreMap.get(id) ?? 0;
        const cluster = clusterOf.get(id);
        const levelColor = node.data("color") as string;
        const clusterColor =
          cluster !== undefined ? clusterColors[cluster % clusterColors.length] : "#6f6a62";
        // 中心度配色：金色到深褐色渐变
        const centralityColor = centralityToColor(norm);
        node.data("centrality", norm);
        node.data("clusterColor", clusterColor);
        node.data("centralityColor", centralityColor);
        const currentColor =
          colorMode === "level"
            ? levelColor
            : colorMode === "cluster"
            ? clusterColor
            : centralityColor;
        node.data("currentColor", currentColor);
      });
    });
  }, [colorMode, centrality, clusterOf]);

  // ============================================================
  //  中心节点 .is-central class（金色光环）
  // ============================================================
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.batch(() => {
      cy.nodes().removeClass("is-central");
      if (highlightCentral && centrality) {
        centrality.topIds.forEach((id) => {
          cy.getElementById(id).addClass("is-central");
        });
      }
    });
  }, [highlightCentral, centrality]);

  // 选中态高亮
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

  // D1 关系过滤
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

  const handleRelayout = useCallback(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.layout(buildLayoutOptions(layoutName, clusterOf)).run();
  }, [layoutName, clusterOf]);

  const handleLayoutChange = (next: LayoutName) => {
    setLayoutName(next);
    const cy = cyRef.current;
    if (!cy) return;
    cy.layout(buildLayoutOptions(next, clusterOf)).run();
  };

  const handleFit = () => {
    cyRef.current?.fit(undefined, 24);
  };

  const annotationCount = doc?.annotations.length ?? 0;
  const filterActive = activeKindGroups.size > 0 || activeOrigins.size > 0;

  // 排行榜数据：top 8 让小图也能看清楚分布
  const rankingScores = useMemo(() => {
    if (!centrality) return [];
    return centrality.scores.slice(0, 8).filter((s) => s.score > 0);
  }, [centrality]);

  return (
    <div className="knowledge-graph-tab">
      <div className="knowledge-graph-toolbar">
        <span className="muted-text">
          节点 {annotationCount} · 边 {relations.length}
          {clusterSizes.length > 0 ? <> · 群组 {clusterSizes.length}</> : null}
        </span>
        <button type="button" className="ghost-link" onClick={handleFit}>
          适应窗口
        </button>
        <button type="button" className="ghost-link" onClick={handleRelayout}>
          重新布局
        </button>
        <button
          type="button"
          className="ghost-link"
          onClick={() => setRankingPanelOpen((v) => !v)}
          title={rankingPanelOpen ? "隐藏排行榜面板" : "显示排行榜面板"}
        >
          {rankingPanelOpen ? "隐藏排行榜" : "显示排行榜"}
        </button>
      </div>

      {/* 布局 + 着色 + 中心节点 合成一行，chip 字号小 */}
      <div className="knowledge-graph-filters" role="group" aria-label="布局与着色">
        <span className="knowledge-graph-filter-label">布局</span>
        {layoutOptions.map((option) => (
          <button
            key={option.id}
            type="button"
            className={
              layoutName === option.id ? "knowledge-graph-chip is-on" : "knowledge-graph-chip"
            }
            onClick={() => handleLayoutChange(option.id)}
            title={option.hint}
          >
            {option.label}
          </button>
        ))}
        <span className="knowledge-graph-filter-divider" aria-hidden />
        <span className="knowledge-graph-filter-label">着色</span>
        {nodeColorModeOptions.map((option) => (
          <button
            key={option.id}
            type="button"
            className={
              colorMode === option.id ? "knowledge-graph-chip is-on" : "knowledge-graph-chip"
            }
            onClick={() => setColorMode(option.id)}
            title={option.hint}
          >
            {option.label}
          </button>
        ))}
        <span className="knowledge-graph-filter-divider" aria-hidden />
        <button
          type="button"
          className={
            highlightCentral
              ? "knowledge-graph-chip knowledge-graph-chip--accent is-on"
              : "knowledge-graph-chip"
          }
          onClick={() => setHighlightCentral((v) => !v)}
          title="给 top-5 中心节点加金色光环 + ★ 标识"
        >
          <Crown size={11} />
          中心
        </button>
      </div>

      {/* 中心性 + 类别 + 来源 合成一行 */}
      <div className="knowledge-graph-filters" role="group" aria-label="中心性与关系筛选">
        <span className="knowledge-graph-filter-label" title="节点重要性打分算法">
          中心性
        </span>
        {centralityKinds.map((kind) => (
          <button
            key={kind}
            type="button"
            className={
              centralityKind === kind ? "knowledge-graph-chip is-on" : "knowledge-graph-chip"
            }
            onClick={() => setCentralityKind(kind)}
            title={centralityKindHints[kind]}
          >
            {centralityKindLabels[kind]}
          </button>
        ))}
        {relations.length > 0 ? (
          <>
            <span className="knowledge-graph-filter-divider" aria-hidden />
            <span className="knowledge-graph-filter-label">类别</span>
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
                <span className="knowledge-graph-filter-divider" aria-hidden />
                <span className="knowledge-graph-filter-label">来源</span>
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
          </>
        ) : null}
      </div>

      {annotationCount === 0 ? (
        <p className="annotation-empty">暂无标注，无法渲染图谱。</p>
      ) : (
        <div className="knowledge-graph-stage">
          <div ref={containerRef} className="knowledge-graph-canvas" />
          {rankingPanelOpen && rankingScores.length > 0 ? (
            <aside
              className="knowledge-graph-ranking"
              aria-label={`${centralityKindLabels[centralityKind]} 排行榜`}
            >
              <header className="knowledge-graph-ranking-head">
                <Sparkles size={13} />
                <span>
                  {centralityKindLabels[centralityKind]} 排行榜 · top {rankingScores.length}
                </span>
                <span className="knowledge-graph-ranking-hint" title={centralityKindHints[centralityKind]}>
                  {shortHintFor(centralityKind)}
                </span>
                {clusterSizes.length > 1 ? (
                  <span className="knowledge-graph-ranking-clusters" aria-label="群组规模">
                    群组
                    {clusterSizes.slice(0, 6).map((size, idx) => (
                      <span
                        key={idx}
                        className="knowledge-graph-ranking-cluster-chip"
                        title={`群组 ${idx} 含 ${size} 个节点`}
                        style={{
                          background: clusterColors[idx % clusterColors.length],
                          color: idx === 0 ? "#1d1a18" : "#f4ece0"
                        }}
                      >
                        {size}
                      </span>
                    ))}
                  </span>
                ) : null}
              </header>
              <ol className="knowledge-graph-ranking-list">
                {rankingScores.map((score, index) => {
                  const cluster = clusterOf.get(score.id);
                  const isSelected = score.id === selectedAnnotationId;
                  const isCentral = centrality?.topIds.has(score.id) ?? false;
                  return (
                    <li
                      key={score.id}
                      className={
                        "knowledge-graph-ranking-item" +
                        (isSelected ? " is-selected" : "") +
                        (isCentral ? " is-central" : "")
                      }
                    >
                      <button
                        type="button"
                        className="knowledge-graph-ranking-button"
                        onClick={() => onSelectAnnotation(score.id)}
                        title={`点击选中此标注（cluster=${cluster ?? "-"}, raw=${score.score.toFixed(4)}）`}
                      >
                        <span className="knowledge-graph-ranking-rank">{index + 1}</span>
                        <span
                          className="knowledge-graph-ranking-dot"
                          style={{
                            background:
                              cluster !== undefined
                                ? clusterColors[cluster % clusterColors.length]
                                : "#6f6a62"
                          }}
                          aria-hidden
                        />
                        <span className="knowledge-graph-ranking-label">{score.label}</span>
                        <span className="knowledge-graph-ranking-bar" aria-hidden>
                          <span
                            className="knowledge-graph-ranking-bar-fill"
                            style={{ width: `${Math.max(4, score.normalized * 100).toFixed(0)}%` }}
                          />
                        </span>
                        <span className="knowledge-graph-ranking-score">
                          {score.normalized > 0 ? score.normalized.toFixed(2) : "-"}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            </aside>
          ) : null}
        </div>
      )}
    </div>
  );
}

// 排行榜 head 展示一条 hint 短文案；过长的完整 hint 放 title 悬浮
function shortHintFor(kind: CentralityKind): string {
  switch (kind) {
    case "pageRank":
      return "被高权重邻居指向 → 综合权威";
    case "degree":
      return "直接邻居最多 → 形象级主角";
    case "betweenness":
      return "最多最短路径 → 桥梁";
    case "closeness":
      return "到其它节点最近 → 群核";
  }
}

function kindLabelOf(kind: string): string {
  return relationKindOptions.find((option) => option.value === kind)?.label ?? kind;
}

// 中心度归一化分数 → 颜色：从冷色（低分）到暖色（高分），与王冠图标 / 排行榜呼应
function centralityToColor(normalized: number): string {
  // 起点：暗灰青 #44544d；终点：金色 #f3a712；中间过渡用线性插值（HSL 更平滑但不必要）
  const start = { r: 0x44, g: 0x54, b: 0x4d };
  const end = { r: 0xf3, g: 0xa7, b: 0x12 };
  const t = Math.max(0, Math.min(1, normalized));
  const r = Math.round(start.r + (end.r - start.r) * t);
  const g = Math.round(start.g + (end.g - start.g) * t);
  const b = Math.round(start.b + (end.b - start.b) * t);
  return `rgb(${r}, ${g}, ${b})`;
}
