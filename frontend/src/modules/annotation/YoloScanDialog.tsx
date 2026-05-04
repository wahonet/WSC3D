/**
 * YOLO 批量扫描参数 dialog `YoloScanDialog`
 *
 * 标注模块工具栏 `Radar` 按钮触发的模态浮层，让用户在跑批量 YOLO 检测前调整：
 * - **类别过滤**：默认 **不过滤**（看 YOLO 真实输出再决定），可手动勾选 30
 *   种 COCO 子集（``yoloCocoUsefulClasses``）
 * - **置信度阈值**：0.02 ~ 0.95，默认 **0.10**（汉画像石浮雕灰度图响应低）
 * - **最大检测数**：默认 80，上限 200
 *
 * 设计要点：
 * - 默认不过滤 + 低阈值是有意为之 ——
 *   汉画像石灰度浮雕在 COCO 通用模型上置信度普遍偏低，0.25 + 30 类白名单实测
 *   会导致几乎所有检测都被丢掉，给用户"什么都没检测到"的错觉；先看真实输出，
 *   再用 chip / 阈值收紧
 * - dialog 顶部明确告诉用户"通用模型识别有限，作 SAM 二次精修的起点"，避免
 *   对识别质量抱过高预期
 * - scanning=true 时按钮置灰防双击
 */

import { useEffect, useState } from "react";
import { yoloCocoUsefulClasses } from "../../api/client";

export type YoloScanOptions = {
  // 选中的 COCO 类别；为空时不做类别过滤（YOLO 可能输出十几种 COCO 类，全要保留）
  classFilter?: string[];
  // 置信度阈值 0.05 ~ 0.95
  confThreshold: number;
  // 最多保留多少个 bbox
  maxDetections: number;
};

// 默认改成"不过滤类别 + 低阈值 0.10"：汉画像石灰度浮雕在 COCO 通用模型上
// 置信度普遍偏低，0.25 + 30 类白名单实测会导致几乎所有检测都被丢掉，给人
// "什么都没检测到"的错觉。让用户先看到 YOLO 真实输出，再用 chip / 阈值收紧。
const defaultOptions: YoloScanOptions = {
  classFilter: undefined,
  confThreshold: 0.1,
  maxDetections: 80
};

/**
 * YOLO 批量扫描参数 dialog：
 *   - 类别过滤：默认 **不过滤**（看 YOLO 真实输出再决定），可手动勾选 30 种 COCO 子集
 *   - 置信度阈值：0.02 ~ 0.95，默认 **0.10**（汉画像石浮雕灰度图响应低）
 *   - 最大检测数：默认 80，上限 200
 *   - 提交：调 onSubmit；scanning=true 时按钮置灰防双击
 *
 * 设计上明确告诉用户"通用模型识别有限，作 SAM 二次精修的起点"，避免对识别质量
 * 抱过高预期。
 */
export function YoloScanDialog({
  open,
  scanning,
  initial,
  onSubmit,
  onCancel
}: {
  open: boolean;
  scanning: boolean;
  initial?: Partial<YoloScanOptions>;
  onSubmit: (options: YoloScanOptions) => void;
  onCancel: () => void;
}) {
  const [classFilter, setClassFilter] = useState<Set<string>>(
    new Set(initial?.classFilter ?? defaultOptions.classFilter)
  );
  const [confThreshold, setConfThreshold] = useState(
    initial?.confThreshold ?? defaultOptions.confThreshold
  );
  const [maxDetections, setMaxDetections] = useState(
    initial?.maxDetections ?? defaultOptions.maxDetections
  );

  // 每次打开 dialog 都重置到默认值；避免上次扫描的设置串到下一次。
  useEffect(() => {
    if (open) {
      setClassFilter(new Set(initial?.classFilter ?? defaultOptions.classFilter));
      setConfThreshold(initial?.confThreshold ?? defaultOptions.confThreshold);
      setMaxDetections(initial?.maxDetections ?? defaultOptions.maxDetections);
    }
  }, [open, initial]);

  if (!open) {
    return null;
  }

  const toggleClass = (label: string) => {
    setClassFilter((prev) => {
      const next = new Set(prev);
      if (next.has(label)) {
        next.delete(label);
      } else {
        next.add(label);
      }
      return next;
    });
  };

  const handleSelectAll = () => setClassFilter(new Set(yoloCocoUsefulClasses));
  const handleSelectNone = () => setClassFilter(new Set());

  const handleSubmit = () => {
    if (scanning) return;
    onSubmit({
      classFilter: classFilter.size === 0 ? undefined : Array.from(classFilter),
      confThreshold,
      maxDetections
    });
  };

  return (
    <div className="yolo-dialog-mask" role="dialog" aria-label="YOLO 批量扫描">
      <div className="yolo-dialog">
        <header className="yolo-dialog-header">
          <h3>YOLO 批量扫描</h3>
          <p className="muted-text">
            通用 YOLOv8n（COCO 80 类）。汉画像石灰度浮雕在通用模型上置信度普遍偏低，
            默认 <strong>不过滤类别 + 阈值 0.10 + CLAHE 增强双跑</strong>，
            让真实输出先暴露出来。结果作为 SAM 二次精修的<strong>起点</strong>使用，
            不要对识别精度抱过高预期。
          </p>
        </header>

        <section className="yolo-dialog-section">
          <div className="yolo-dialog-section-title">
            <span>类别过滤</span>
            <span className="muted-text">已选 {classFilter.size}/{yoloCocoUsefulClasses.length}</span>
            <button type="button" className="ghost-link" onClick={handleSelectAll}>全选</button>
            <button type="button" className="ghost-link" onClick={handleSelectNone}>清空</button>
          </div>
          <div className="yolo-dialog-classes">
            {yoloCocoUsefulClasses.map((label) => (
              <label key={label} className={classFilter.has(label) ? "yolo-class-chip is-on" : "yolo-class-chip"}>
                <input
                  type="checkbox"
                  checked={classFilter.has(label)}
                  onChange={() => toggleClass(label)}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </section>

        <section className="yolo-dialog-section">
          <div className="yolo-dialog-section-title">
            <span>置信度阈值</span>
            <span className="muted-text">推荐 0.05 ~ 0.20；汉画像石不要超过 0.30</span>
          </div>
          <div className="yolo-dialog-slider">
            <input
              type="range"
              min={0.02}
              max={0.95}
              step={0.01}
              value={confThreshold}
              onChange={(event) => setConfThreshold(Number(event.target.value))}
            />
            <span className="yolo-dialog-value">{confThreshold.toFixed(2)}</span>
          </div>
        </section>

        <section className="yolo-dialog-section">
          <div className="yolo-dialog-section-title">
            <span>最大检测数</span>
            <span className="muted-text">候选过多会拖慢审阅</span>
          </div>
          <div className="yolo-dialog-slider">
            <input
              type="range"
              min={5}
              max={200}
              step={5}
              value={maxDetections}
              onChange={(event) => setMaxDetections(Number(event.target.value))}
            />
            <span className="yolo-dialog-value">{maxDetections}</span>
          </div>
        </section>

        <footer className="yolo-dialog-footer">
          <button type="button" className="ghost-cta" onClick={onCancel} disabled={scanning}>
            取消
          </button>
          <button type="button" className="primary-cta" onClick={handleSubmit} disabled={scanning}>
            {scanning ? "扫描中…" : "开始扫描"}
          </button>
        </footer>
      </div>
    </div>
  );
}
