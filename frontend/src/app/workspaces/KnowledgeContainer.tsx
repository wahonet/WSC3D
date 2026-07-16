/**
 * 知识库工作区容器（第三工作区）
 *
 * 三栏布局，对照参照系统"汉画术语概念树与知识图谱"：
 * - 左：概念树（一级/二级分类 + 概念叶 + 计数），点分类过滤、点概念选中
 * - 中：检索条（概念/术语/原文/出处混合检索）+ 列表 / 图谱两种视图
 * - 右：详情（概念卡 / 新建概念 / 文献与文段录入）
 *
 * 数据流：容器持有 snapshot（/api/kb/snapshot 一次拉全），所有 CRUD 成功后
 * reload；概念详情与子图按需拉取。
 */

import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchConceptDetail,
  fetchConceptGraph,
  fetchKbSnapshot,
  fetchOverviewGraph,
  searchKb,
  type KbConceptDetail,
  type KbGraph,
  type KbSearchResult,
  type KbSnapshot
} from "../../api/kb";
import { Button } from "../../ui/Button";
import { Input, Select } from "../../ui/Field";
import { useWorkspaceMode } from "../contexts/WorkspaceModeContext";
import { downloadBlob } from "../utils";

const ConceptTree = lazy(() => import("../../modules/knowledge/ConceptTree").then((m) => ({ default: m.ConceptTree })));
const ConceptDetailPanel = lazy(() =>
  import("../../modules/knowledge/ConceptDetailPanel").then((m) => ({ default: m.ConceptDetailPanel }))
);
const ConceptCreateForm = lazy(() =>
  import("../../modules/knowledge/ConceptDetailPanel").then((m) => ({ default: m.ConceptCreateForm }))
);
const SourcesPanel = lazy(() => import("../../modules/knowledge/SourcesPanel").then((m) => ({ default: m.SourcesPanel })));
const ConceptGraphView = lazy(() =>
  import("../../modules/knowledge/ConceptGraphView").then((m) => ({ default: m.ConceptGraphView }))
);

type RightPane =
  | { kind: "empty" }
  | { kind: "concept" }
  | { kind: "create-concept"; categoryId: string; subcategoryId?: string }
  | { kind: "sources"; editingSegmentId?: string };

export function KnowledgeContainer() {
  const { workspaceMode } = useWorkspaceMode();
  const [snapshot, setSnapshot] = useState<KbSnapshot>();
  const [loadError, setLoadError] = useState<string>();
  const [status, setStatus] = useState("");
  const [activeCategoryId, setActiveCategoryId] = useState<string>();
  const [selectedConceptId, setSelectedConceptId] = useState<string>();
  const [detail, setDetail] = useState<KbConceptDetail>();
  const [rightPane, setRightPane] = useState<RightPane>({ kind: "empty" });
  const [view, setView] = useState<"list" | "graph">("list");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<KbSearchResult[]>([]);
  const [graph, setGraph] = useState<KbGraph>();
  const [hasEntered, setHasEntered] = useState(false);

  const isActive = workspaceMode === "knowledge";
  useEffect(() => {
    if (isActive && !hasEntered) setHasEntered(true);
  }, [isActive, hasEntered]);

  const reload = useCallback(async () => {
    try {
      const data = await fetchKbSnapshot();
      setSnapshot(data);
      setLoadError(undefined);
      return data;
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
      return undefined;
    }
  }, []);

  useEffect(() => {
    if (hasEntered && !snapshot) void reload();
  }, [hasEntered, snapshot, reload]);

  const runSearch = useCallback(
    async (q: string, categoryId?: string) => {
      try {
        setResults(await searchKb(q, categoryId));
      } catch (error) {
        setStatus(`检索失败：${error instanceof Error ? error.message : String(error)}`);
      }
    },
    []
  );

  // 快照或过滤变化时刷新列表（空 query = 按分类浏览全部概念）
  useEffect(() => {
    if (!snapshot) return;
    void runSearch(query, activeCategoryId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot, activeCategoryId]);

  // 选中概念 → 拉详情；图谱模式下同时拉局部子图
  useEffect(() => {
    if (!selectedConceptId) {
      setDetail(undefined);
      return;
    }
    let cancelled = false;
    fetchConceptDetail(selectedConceptId)
      .then((data) => {
        if (!cancelled) setDetail(data);
      })
      .catch(() => {
        if (!cancelled) {
          setDetail(undefined);
          setSelectedConceptId(undefined);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedConceptId, snapshot]);

  useEffect(() => {
    if (view !== "graph") return;
    let cancelled = false;
    const load = selectedConceptId ? fetchConceptGraph(selectedConceptId) : fetchOverviewGraph();
    load
      .then((data) => {
        if (!cancelled) setGraph(data);
      })
      .catch((error: Error) => setStatus(`图谱加载失败：${error.message}`));
    return () => {
      cancelled = true;
    };
  }, [view, selectedConceptId, snapshot]);

  const selectConcept = useCallback((id: string) => {
    setSelectedConceptId(id);
    setRightPane({ kind: "concept" });
  }, []);

  const conceptById = useMemo(() => new Map((snapshot?.concepts ?? []).map((c) => [c.id, c])), [snapshot?.concepts]);

  if (!hasEntered) return null;

  const layerClass = isActive ? "wsc-stage__layer is-active" : "wsc-stage__layer is-hidden";

  return (
    <div className={`${layerClass} kb-shell`}>
      {!snapshot ? (
        <div className="wsc-empty">{loadError ? `知识库加载失败：${loadError}` : "正在加载知识库…"}</div>
      ) : (
        <>
          <aside className="kb-shell__tree">
            <Suspense fallback={<p className="ui-muted">加载概念树…</p>}>
              <ConceptTree
                snapshot={snapshot}
                selectedConceptId={selectedConceptId}
                activeCategoryId={activeCategoryId}
                onSelectConcept={selectConcept}
                onSelectCategory={setActiveCategoryId}
                onCreateConcept={(categoryId, subcategoryId) =>
                  setRightPane({ kind: "create-concept", categoryId, subcategoryId })
                }
              />
            </Suspense>
          </aside>

          <section className="kb-shell__main">
            <div className="kb-toolbar">
              <Input
                value={query}
                placeholder="检索概念 / 术语 / 原文 / 出处…"
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void runSearch(query, activeCategoryId);
                }}
              />
              <Button compact onClick={() => void runSearch(query, activeCategoryId)}>
                查询
              </Button>
              <Select
                value={activeCategoryId ?? ""}
                onChange={(e) => setActiveCategoryId(e.target.value || undefined)}
              >
                <option value="">全部分类</option>
                {snapshot.categories
                  .filter((c) => !c.parentId)
                  .map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
              </Select>
              <div className="wsc-segmented kb-toolbar__views">
                <button type="button" className={view === "list" ? "is-active" : ""} onClick={() => setView("list")}>
                  列表
                </button>
                <button type="button" className={view === "graph" ? "is-active" : ""} onClick={() => setView("graph")}>
                  图谱
                </button>
              </div>
              <Button compact variant="ghost" onClick={() => setRightPane({ kind: "sources" })}>
                文献与文段
              </Button>
              {view === "graph" && graph ? (
                <Button
                  compact
                  variant="ghost"
                  onClick={() => {
                    const name = selectedConceptId
                      ? `kb-graph-${conceptById.get(selectedConceptId)?.label ?? selectedConceptId}.json`
                      : "kb-graph-overview.json";
                    downloadBlob(new Blob([JSON.stringify(graph, null, 2)], { type: "application/json" }), name);
                  }}
                >
                  导出当前数据
                </Button>
              ) : null}
            </div>

            {status ? (
              <div className="kb-status" role="status" onAnimationEnd={() => setStatus("")}>
                {status}
              </div>
            ) : null}

            {view === "graph" ? (
              <Suspense fallback={<div className="wsc-empty">加载图谱…</div>}>
                {graph ? (
                  <ConceptGraphView
                    graph={graph}
                    mode={selectedConceptId ? "local" : "overview"}
                    selectedConceptId={selectedConceptId}
                    onSelectConcept={selectConcept}
                  />
                ) : (
                  <div className="wsc-empty">加载图谱…</div>
                )}
              </Suspense>
            ) : (
              <SearchResultList
                results={results}
                selectedConceptId={selectedConceptId}
                onSelectConcept={selectConcept}
                onOpenSegment={(id) => setRightPane({ kind: "sources", editingSegmentId: id })}
                onOpenSources={() => setRightPane({ kind: "sources" })}
              />
            )}
          </section>

          <aside className="kb-shell__detail">
            <Suspense fallback={<p className="ui-muted">加载面板…</p>}>
              {rightPane.kind === "create-concept" ? (
                <ConceptCreateForm
                  snapshot={snapshot}
                  presetCategoryId={rightPane.categoryId}
                  presetSubcategoryId={rightPane.subcategoryId}
                  onCreated={(conceptId) => {
                    void reload().then(() => selectConcept(conceptId));
                  }}
                  onCancel={() => setRightPane(selectedConceptId ? { kind: "concept" } : { kind: "empty" })}
                  onStatus={setStatus}
                />
              ) : rightPane.kind === "sources" ? (
                <SourcesPanel
                  snapshot={snapshot}
                  editingSegmentId={rightPane.editingSegmentId}
                  onChanged={() => void reload()}
                  onStatus={setStatus}
                  onCloseSegmentEditor={() => setRightPane({ kind: "sources" })}
                />
              ) : rightPane.kind === "concept" && detail ? (
                <ConceptDetailPanel
                  detail={detail}
                  snapshot={snapshot}
                  onChanged={() => void reload()}
                  onSelectConcept={selectConcept}
                  onOpenSegment={(id) => setRightPane({ kind: "sources", editingSegmentId: id })}
                  onStatus={setStatus}
                />
              ) : (
                <div className="kb-detail kb-detail--empty">
                  <p className="ui-muted">点击左侧概念或检索结果查看详情；</p>
                  <p className="ui-muted">「文献与文段」录入文段并自动识别提及；</p>
                  <p className="ui-muted">概念树每个类目右侧 + 号可新建概念。</p>
                </div>
              )}
            </Suspense>
          </aside>
        </>
      )}
    </div>
  );
}

function SearchResultList({
  results,
  selectedConceptId,
  onSelectConcept,
  onOpenSegment,
  onOpenSources
}: {
  results: KbSearchResult[];
  selectedConceptId?: string;
  onSelectConcept: (id: string) => void;
  onOpenSegment: (id: string) => void;
  onOpenSources: () => void;
}) {
  if (results.length === 0) {
    return <div className="wsc-empty">没有匹配结果。概念树右侧 + 号新建概念，或到「文献与文段」录入文段。</div>;
  }
  return (
    <ul className="kb-results">
      {results.map((result) => {
        if (result.type === "concept") {
          return (
            <li key={`c-${result.id}`}>
              <button
                type="button"
                className={`kb-result${selectedConceptId === result.id ? " is-selected" : ""}`}
                onClick={() => onSelectConcept(result.id)}
              >
                <span className="kb-result__badge is-concept">Concept</span>
                <span className="kb-result__title">{result.label}</span>
                <span className="kb-result__meta">
                  {result.termCount} 词 · {result.segmentCount} 段
                </span>
              </button>
            </li>
          );
        }
        if (result.type === "term") {
          return (
            <li key={`t-${result.id}`}>
              <button type="button" className="kb-result" onClick={() => onSelectConcept(result.conceptId)}>
                <span className="kb-result__badge is-term">Term</span>
                <span className="kb-result__title">{result.form}</span>
                <span className="kb-result__meta">归一到 {result.conceptLabel}</span>
              </button>
            </li>
          );
        }
        if (result.type === "segment") {
          return (
            <li key={`s-${result.id}`}>
              <button type="button" className="kb-result" onClick={() => onOpenSegment(result.id)}>
                <span className="kb-result__badge is-segment">Segment</span>
                <span className="kb-result__title kb-result__title--wrap">{result.snippet}</span>
                <span className="kb-result__meta">
                  {result.sourceTitle}
                  {result.page ? ` · 页 ${result.page}` : ""} · 提及 {result.mentionCount}
                </span>
              </button>
            </li>
          );
        }
        return (
          <li key={`src-${result.id}`}>
            <button type="button" className="kb-result" onClick={onOpenSources}>
              <span className="kb-result__badge is-source">Source</span>
              <span className="kb-result__title">{result.title}</span>
              <span className="kb-result__meta">
                {result.year ?? ""} · {result.segmentCount} 段
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
