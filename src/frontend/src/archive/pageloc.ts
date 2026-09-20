/** 著录loc文本 -> PDF阅读器定位页(1基, 供 #page= 锚点使用) */

export const BASE_BOOK_ID = '蒋英炬吴文祺2014汉代武氏墓群石刻研究修订本';
/** 修订本: 阅读器页 = 书页 + 14 (正文书页1从阅读器第15页起) */
const BASE_OFFSET = 14;

export function pageFromLoc(bookId: string, loc: string | undefined): number | null {
  if (!loc) return null;
  /* 各书refs中直接标注的PDF页码, 如 "PDF106–107(原书93–95)"、"PDF6(刊页118)" */
  let m = loc.match(/PDF\s*页?\s*(\d+)/i);
  if (m) return parseInt(m[1], 10);
  if (bookId === BASE_BOOK_ID) {
    if (/序言/.test(loc)) return 7;                    // 再版序言起始页
    m = loc.match(/[书]?页\s*(\d+)/);                  // "配置页63–65" -> 63
    if (m) return parseInt(m[1], 10) + BASE_OFFSET;
  }
  return null;
}

/** 定位标签: 修订本补书页号说明 */
export function pageLabel(bookId: string, page: number): string {
  if (bookId === BASE_BOOK_ID && page > BASE_OFFSET) {
    return `PDF第${page}页（书页${page - BASE_OFFSET}）`;
  }
  return `PDF第${page}页`;
}

/** 著录点击时的页内高亮词: 原石编号 > 注记中《碑名》 > 石刻题名(去编号前缀) */
export function refHighlightTerms(stoneName: string, refTitle: string, note: string): string[] {
  const terms: string[] = [];
  const m = (note || '').match(/原石编号[“"『]([^”"』]{2,12})[”"』]/);
  if (m) terms.push(m[1]);
  if (!terms.length && note) {
    for (const x of note.matchAll(/《([^》]{2,14})》/g)) {
      if (x[1] && !refTitle.includes(x[1])) { terms.push(x[1]); break; }
    }
  }
  let n = (stoneName || '').replace(/^\d+\s*/, '').replace(/[（(].*$/, '').trim();
  if (/^[A-Za-z0-9×.\s-]+$/.test(n)) n = '';          // 纯编号/尺寸型题名无检索意义
  if (n.length >= 2 && !terms.includes(n)) terms.push(n);
  return terms.slice(0, 2);
}
