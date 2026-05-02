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
