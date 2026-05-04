/**
 * 颜色选择 popover `ColorPopover`
 *
 * 标注列表与详情面板里的颜色按钮：点击展开 10 色调色板（与
 * `annotationPalette` 一致）+ HTML5 ``<input type="color">`` 自定义色。
 *
 * 设计要点：
 * - 点击外部 / Escape 自动关闭
 * - 自定义颜色实时生效，但不关闭 popover，便于对比微调
 * - 支持左对齐 / 右对齐（避免靠近视口右边界时被裁掉）
 *
 * 使用时请保证父级容器有足够空间显示（会绝对定位在按钮正下方）。
 */

import { useEffect, useRef, useState } from "react";
import { annotationPalette } from "./store";

type ColorPopoverProps = {
  color: string;
  onChange: (color: string) => void;
  title?: string;
  size?: number;
  align?: "left" | "right";
};
export function ColorPopover({ color, onChange, title = "更改颜色", size = 16, align = "left" }: ColorPopoverProps) {
  const [open, setOpen] = useState(false);
  const popRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const handleDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) {
        return;
      }
      if (popRef.current?.contains(target) || buttonRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleDown);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleDown);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const handlePick = (next: string) => {
    onChange(next);
    setOpen(false);
  };

  // 自定义颜色实时生效，但不关闭 popover，便于对比微调。
  const handleCustom = (event: React.ChangeEvent<HTMLInputElement>) => {
    onChange(event.target.value);
  };

  const normalizedForInput = /^#[0-9a-f]{6}$/i.test(color) ? color : "#f3a712";

  return (
    <div className="color-popover-wrap">
      <button
        ref={buttonRef}
        type="button"
        className="annotation-color-dot"
        style={{ background: color, width: size, height: size }}
        title={title}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
      />
      {open ? (
        <div
          ref={popRef}
          className={align === "right" ? "color-popover align-right" : "color-popover"}
          role="dialog"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="color-popover-grid">
            {annotationPalette.map((swatch) => (
              <button
                key={swatch}
                type="button"
                className={swatch.toLowerCase() === color.toLowerCase() ? "color-swatch active" : "color-swatch"}
                style={{ background: swatch }}
                title={swatch}
                onClick={() => handlePick(swatch)}
              />
            ))}
          </div>
          <label className="color-popover-custom">
            <span>自定义</span>
            <input type="color" value={normalizedForInput} onChange={handleCustom} />
          </label>
        </div>
      ) : null}
    </div>
  );
}
