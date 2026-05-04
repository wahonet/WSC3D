/**
 * 画像石结构化档案 Markdown 解析器
 *
 * 把仓库 `画像石结构化分档/` 下的每份 `.md` 档案解析成机器可读的
 * `StoneMetadata` 对象，让标注 / 浏览模块能从档案里读图层标题、尺寸、对应
 * 来源等信息。
 *
 * 约定的 Markdown 结构示例：
 * ```markdown
 * # 29东汉武氏祠左石室后壁小龛西侧画像石
 *
 * **尺寸（厘米）**：高 110、宽 84、厚 16
 * **尺寸说明**：高边稍残
 *
 * ### 第一层：青龙
 * **对应来源**：图录第 X 页
 *
 * 描绘…
 *
 * ### 第二层：白虎
 * **对应来源**：图录第 Y 页
 * ...
 * ```
 *
 * 解析要点：
 * - 文件名前缀数字（如 `29`）→ `stone_id`（补 0 至 2 位，如 `29` → `29`）
 * - `# Title` 一级标题 → `name`，去掉前缀数字 / 空白
 * - **尺寸** 行匹配高 / 宽 / 厚（厘米）
 * - `### Heading` 三级标题 → 一个 `LayerData`，正文段落作为 panel content
 *
 * 设计要点：
 * - 仅从档案里抽出"机器可读"的字段，原始 Markdown 内容也保留
 *   （`layers[].content`），避免遗漏
 * - 当尺寸 / 层级缺失时返回空数组而非抛错，让目录扫描容错
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { DimensionData, LayerData, StoneMetadata } from "../types.js";

const headingPattern = /^###\s+(.+)$/gm;

export async function parseMarkdownMetadata(filePath: string): Promise<StoneMetadata> {
  const markdown = await readFile(filePath, "utf8");
  const fileName = path.basename(filePath);
  const idMatch = fileName.match(/^(\d+)/);
  const stoneId = idMatch?.[1].padStart(2, "0") ?? slugify(fileName.replace(/\.md$/i, ""));
  const title = parseTitle(markdown, fileName);
  const dimensions = parseDimensions(markdown);
  const dimension_note = parseBoldLine(markdown, "尺寸说明");
  const layers = parseLayers(markdown);

  return {
    stone_id: stoneId,
    name: title,
    dimensions,
    dimension_note,
    layers,
    source_file: fileName
  };
}

function parseTitle(markdown: string, fileName: string): string {
  const titleMatch = markdown.match(/^#\s*(?:\d+[.、]\s*)?(.+)$/m);
  if (titleMatch?.[1]) {
    return titleMatch[1].trim();
  }
  return fileName.replace(/^\d+_?/, "").replace(/\.md$/i, "");
}

function parseDimensions(markdown: string): DimensionData {
  const raw = parseBoldLine(markdown, "尺寸（厘米）") ?? parseBoldLine(markdown, "尺寸");
  const values = raw?.match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  const [height, width, thickness] = values;

  return {
    height,
    width,
    thickness,
    unit: "cm",
    raw,
    order: "height_width_thickness"
  };
}

function parseBoldLine(markdown: string, label: string): string | undefined {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = markdown.match(new RegExp(`\\*\\*${escaped}\\*\\*\\s*[:：]\\s*(.+)`));
  return match?.[1]?.trim();
}

function parseLayers(markdown: string): LayerData[] {
  const matches = [...markdown.matchAll(headingPattern)];
  if (matches.length === 0) {
    return [];
  }

  return matches.map((match, index) => {
    const title = match[1].trim();
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? markdown.length;
    const section = markdown.slice(start, end).trim();
    const source = parseBoldLine(section, "对应来源");
    const content = cleanupSectionText(section);

    return {
      layer_index: index + 1,
      title,
      source,
      content,
      panels: [
        {
          panel_index: 1,
          position: title,
          source,
          content
        }
      ]
    };
  });
}

function cleanupSectionText(section: string): string {
  return section
    .replace(/\*\*对应来源\*\*\s*[:：]\s*.+/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\p{Letter}\p{Number}-]+/gu, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}
