// 知识图谱度量与"叙事中心"识别
//
// 参考：
// - Freeman 1979《Centrality in Social Networks》—— degree / betweenness / closeness
//   三种经典中心性
// - Brin & Page 1998《The Anatomy of a Large-Scale Hypertextual Web Search Engine》
//   —— PageRank
// - Bonacich 1972《Factoring and weighting approaches to status scores》
//   —— Eigenvector centrality
// - Newman 2010《Networks: An Introduction》—— 综合定义
//
// 应用场景：汉画像石标注网络中，找出"叙事中心" / "构图中心" / "枢纽节点"。
// 不同中心性回答不同问题：
//   - **Degree**：直接邻居最多 = 出现频次最高（如"主神"被多个角色围绕）
//   - **Betweenness**：处于最多最短路径上 = 桥梁节点（连接两个语义簇的关键人物）
//   - **Closeness**：与其他所有节点平均距离最近 = "群核"
//   - **PageRank**：被高权重节点指向的节点也高权重 = 综合权威度
//   - **Eigenvector**：与高分节点相连的节点也高分（PageRank 是其变体）

import type { Core, NodeSingular } from "cytoscape";

export type CentralityKind = "degree" | "betweenness" | "closeness" | "pageRank";

export const centralityKindLabels: Record<CentralityKind, string> = {
  degree: "度数",
  betweenness: "介数",
  closeness: "接近度",
  pageRank: "PageRank"
};

export const centralityKindHints: Record<CentralityKind, string> = {
  degree: "直接邻居最多 = 在画面里被最多其他形象围绕（最直觉的主角）",
  betweenness: "处于最多最短路径上 = 桥梁节点（连接两个语义簇的关键形象）",
  closeness: "与其他所有节点平均距离最近 = 群核（构图重心）",
  pageRank: "被高权重节点指向的节点也高权重 = 综合权威度（论文常用）"
};

export type CentralityScore = {
  id: string;
  label: string;
  score: number;
  // 归一化到 [0, 1] 的相对分数；用于颜色 / 大小映射
  normalized: number;
};

export type CentralityResult = {
  kind: CentralityKind;
  scores: CentralityScore[];
  // top-N 节点 id 集合（默认 5 个）
  topIds: Set<string>;
};

const TOP_N = 5;

/**
 * 计算指定算法下的所有节点中心性，按分数降序排列。
 *
 * Cytoscape.js 自带 4 种中心性算法的实现，但 API 略有差异：
 *  - degreeCentrality / betweennessCentrality / closenessCentrality 是
 *    cy.elements().X(...) 形式（针对一组节点的批量计算器）
 *  - pageRank 是 cy.elements().pageRank() 直接得到 rank() / ranks()
 *
 * 包一层让上层只关心"我要 PageRank"。
 */
export function computeCentrality(
  cy: Core,
  kind: CentralityKind,
  options?: { topN?: number; treatAsUndirected?: boolean }
): CentralityResult {
  const topN = options?.topN ?? TOP_N;
  const directed = !(options?.treatAsUndirected ?? true);
  const nodes = cy.nodes();

  if (nodes.length === 0) {
    return { kind, scores: [], topIds: new Set() };
  }

  let raw: Array<{ node: NodeSingular; score: number }> = [];

  if (kind === "pageRank") {
    const pr = cy.elements().pageRank({ dampingFactor: 0.85, precision: 1e-6, iterations: 200 });
    nodes.forEach((node) => {
      raw.push({ node, score: pr.rank(node) });
    });
  } else if (kind === "degree") {
    // degreeCentralityNormalized：directed=false 走 undirected 实现，返回 .degree()
    // directed=true 时用 .indegree() + .outdegree() 总和（更贴合"被多少关系直接关联"）
    const dc = cy.elements().degreeCentralityNormalized({ directed, weight: () => 1 } as never) as {
      degree?: (n: NodeSingular) => number;
      indegree?: (n: NodeSingular) => number;
      outdegree?: (n: NodeSingular) => number;
    };
    nodes.forEach((node) => {
      let score: number;
      if (typeof dc.degree === "function") {
        score = dc.degree(node);
      } else {
        score = (dc.indegree?.(node) ?? 0) + (dc.outdegree?.(node) ?? 0);
      }
      raw.push({ node, score });
    });
  } else if (kind === "betweenness") {
    const bc = cy.elements().betweennessCentrality({ directed, weight: () => 1 } as never);
    nodes.forEach((node) => {
      raw.push({ node, score: bc.betweenness(node) });
    });
  } else if (kind === "closeness") {
    const cc = cy.elements().closenessCentralityNormalized({ directed, weight: () => 1 } as never);
    nodes.forEach((node) => {
      raw.push({ node, score: cc.closeness(node) });
    });
  }

  // 异常或孤立子图导致 NaN / Infinity 的兜底
  raw = raw.map((r) => ({
    node: r.node,
    score: Number.isFinite(r.score) ? r.score : 0
  }));

  const max = raw.reduce((acc, r) => Math.max(acc, r.score), 0);
  const min = raw.reduce((acc, r) => Math.min(acc, r.score), max);
  const range = max - min;

  raw.sort((a, b) => b.score - a.score);

  const scores: CentralityScore[] = raw.map((r) => ({
    id: r.node.id(),
    label: (r.node.data("label") as string) || "未命名",
    score: r.score,
    normalized: range > 0 ? (r.score - min) / range : 0
  }));

  const topIds = new Set(scores.slice(0, topN).map((s) => s.id));
  return { kind, scores, topIds };
}

/**
 * 群组检测：用 Cytoscape 自带 markovClustering（MCL）。
 *
 * MCL 是一种基于"随机游走"的图聚类算法，对小到中型图效果好（节点 < 500）。
 * 在汉画像石标注里能把"叙事簇"识别出来 —— 比如"西王母 + 玉兔 + 九尾狐"
 * 这种紧密相连的子图。
 *
 * 返回：每个节点 → 群组编号（同号 = 同簇）；簇按规模降序编号 0..N。
 */
export function detectClusters(cy: Core): {
  clusterOf: Map<string, number>;
  clusterSizes: number[];
} {
  const clusterOf = new Map<string, number>();
  const nodes = cy.nodes();
  if (nodes.length === 0) {
    return { clusterOf, clusterSizes: [] };
  }

  try {
    const clusters = cy.elements().markovClustering({
      expandFactor: 2,
      inflateFactor: 2.0,
      multFactor: 1,
      maxIterations: 30
    });
    // 按规模降序，群组编号 0 = 最大簇
    const sortedClusters = [...clusters].sort((a, b) => b.length - a.length);
    sortedClusters.forEach((cluster, idx) => {
      cluster.forEach((node) => {
        clusterOf.set(node.id(), idx);
      });
    });
    return { clusterOf, clusterSizes: sortedClusters.map((c) => c.length) };
  } catch (error) {
    // MCL 在某些退化图（全连通 / 全孤立）会抛错，退化到"按连通分量"
    const components = cy.elements().components();
    const sortedComponents = [...components].sort((a, b) => b.length - a.length);
    sortedComponents.forEach((component, idx) => {
      component.nodes().forEach((node) => {
        clusterOf.set(node.id(), idx);
      });
    });
    return { clusterOf, clusterSizes: sortedComponents.map((c) => c.nodes().length) };
  }
}

// 群组高亮配色：12 种区分度高的颜色，超出后循环。
// 第一种（金色）特意留给最大簇，与"叙事核心"视觉呼应。
export const clusterColors: string[] = [
  "#f3a712", // 金（叙事中心）
  "#2ec4b6", // 青
  "#c084fc", // 紫
  "#3a86ff", // 蓝
  "#ff5f57", // 朱
  "#facc15", // 黄
  "#10b981", // 翠
  "#ec4899", // 粉
  "#06b6d4", // 海蓝
  "#a855f7", // 紫罗兰
  "#84cc16", // 黄绿
  "#f97316"  // 橙红
];
