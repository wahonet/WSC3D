/**
 * 概念图谱视图（知识库工作区中栏的"图谱"模式）
 *
 * 两种视图，对照参照系统：
 * - **总览图**：概念树（分类 hub + 概念叶），concentric 布局，按一级类目着色
 * - **局部图**：选中概念的 Concept–Term–Segment–Source 星型 + 语义关系 /
 *   共现邻居，边上标关系类型；点概念节点联动右栏详情
 *
 * 数据来自后端 /api/kb/graph/*（节点带 kind 与 categoryId），本组件只负责渲染；
 * "导出当前数据"把当前子图 JSON 直接下载。
 */

import cytoscape from "cytoscape";
import type { Core, ElementDefinition } from "cytoscape";
import { useEffect, useMemo, useRef } from "react";
import type { KbGraph } from "../../api/kb";

// 一级类目着色（顺序与种子分类树对应；超出取模）
const CATEGORY_PALETTE = [
  "#e8590c",
  "#2f9e44",
  "#1971c2",
  "#9c36b5",
  "#f08c00",
  "#c2255c",
  "#0c8599",
  "#5f3dc4",
  "#846358",
  "#3b5bdb",
  "#87500f"
];

const NODE_KIND_SHAPES: Record<string, cytoscape.Css.NodeShape> = {
  concept: "ellipse",
  category: "round-hexagon",
  term: "round-rectangle",
  segment: "diamond",
  source: "round-tag"
};

export type ConceptGraphViewProps = {
  graph: KbGraph;
  mode: "overview" | "local";
  selectedConceptId?: string;
  onSelectConcept: (id: string) => void;
};

export function ConceptGraphView({ graph, mode, selectedConceptId, onSelectConcept }: ConceptGraphViewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Core | null>(null);
  const onSelectRef = useRef(onSelectConcept);
  onSelectRef.current = onSelectConcept;

  const categoryColor = useMemo(() => {
    const topIds = [...new Set(graph.nodes.filter((n) => n.kind === "category" && !n.categoryId).map((n) => n.id))];
    const byCategory = new Map<string, string>();
    topIds.forEach((id, index) => byCategory.set(id, CATEGORY_PALETTE[index % CATEGORY_PALETTE.length]));
    return (categoryId?: string) => (categoryId ? byCategory.get(categoryId) ?? "#5c940d" : "#868e96");
  }, [graph.nodes]);

  useEffect(() => {
    if (!hostRef.current) return;
    const elements: ElementDefinition[] = [];
    const nodeIds = new Set<string>();
    for (const node of graph.nodes) {
      nodeIds.add(node.id);
      elements.push({
        data: {
          id: node.id,
          label: node.label,
          kind: node.kind,
          color:
            node.kind === "category"
              ? categoryColor(node.categoryId ?? node.id)
              : node.kind === "concept"
                ? categoryColor(node.categoryId)
                : node.kind === "source"
                  ? "#4263eb"
                  : node.kind === "segment"
                    ? "#495057"
                    : "#b08968"
        }
      });
    }
    for (const edge of graph.edges) {
      if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue;
      elements.push({
        data: {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          label: edge.kind === "IN_CATEGORY" || edge.kind === "SUBCATEGORY_OF" ? "" : edge.kind,
          weight: edge.weight ?? 1,
          dashed: edge.kind === "CO_OCCURS_IN_SEGMENT" ? 1 : 0
        }
      });
    }

    cyRef.current?.destroy();
    const cy = cytoscape({
      container: hostRef.current,
      elements,
      wheelSensitivity: 0.2,
      style: [
        {
          selector: "node",
          style: {
            label: "data(label)",
            "background-color": "data(color)",
            color: "#3f3a34",
            "font-size": mode === "overview" ? 9 : 11,
            "text-valign": "bottom",
            "text-margin-y": 4,
            "text-max-width": "90px",
            "text-wrap": "ellipsis",
            width: mode === "overview" ? 14 : 22,
            height: mode === "overview" ? 14 : 22
          }
        },
        {
          selector: "node[kind = 'category']",
          style: {
            shape: NODE_KIND_SHAPES.category,
            width: 34,
            height: 34,
            "font-size": 12,
            "font-weight": "bold",
            "text-valign": "center",
            color: "#ffffff",
            "text-max-width": "60px"
          }
        },
        { selector: "node[kind = 'term']", style: { shape: NODE_KIND_SHAPES.term, width: 16, height: 16 } },
        { selector: "node[kind = 'segment']", style: { shape: NODE_KIND_SHAPES.segment, width: 16, height: 16 } },
        { selector: "node[kind = 'source']", style: { shape: NODE_KIND_SHAPES.source, width: 18, height: 18 } },
        {
          selector: "edge",
          style: {
            width: 1.2,
            "line-color": "#adb5bd",
            "curve-style": "bezier",
            label: "data(label)",
            "font-size": 8,
            color: "#868e96",
            "text-rotation": "autorotate",
            "target-arrow-shape": "none"
          }
        },
        { selector: "edge[dashed = 1]", style: { "line-style": "dashed" } },
        {
          selector: "node.is-selected",
          style: { "border-width": 3, "border-color": "#f3a712" }
        }
      ]
    });

    cy.on("tap", "node", (event) => {
      const kind = event.target.data("kind") as string;
      if (kind === "concept") onSelectRef.current(event.target.id() as string);
    });

    const layout =
      mode === "overview"
        ? cy.layout({ name: "concentric", concentric: (n) => (n.data("kind") === "category" ? 3 : 1), levelWidth: () => 1, minNodeSpacing: 12 })
        : cy.layout({ name: "cose", animate: false, nodeRepulsion: () => 8000, idealEdgeLength: () => 80 });
    layout.run();
    cyRef.current = cy;

    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, [graph, mode, categoryColor]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.nodes().removeClass("is-selected");
    if (selectedConceptId) {
      cy.getElementById(selectedConceptId).addClass("is-selected");
    }
  }, [selectedConceptId, graph]);

  return <div className="kb-graph-host" ref={hostRef} />;
}
