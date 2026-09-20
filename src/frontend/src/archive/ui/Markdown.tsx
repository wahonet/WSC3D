import { useMemo } from 'react';
import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: false, async: false });

const allowed = new Set(['P', 'BR', 'STRONG', 'EM', 'DEL', 'S', 'B', 'I', 'U', 'UL', 'OL', 'LI',
  'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'CODE', 'TABLE', 'THEAD', 'TBODY',
  'TFOOT', 'TR', 'TH', 'TD', 'CAPTION', 'HR', 'A', 'IMG', 'DIV', 'SPAN', 'DETAILS', 'SUMMARY',
  'FIGURE', 'FIGCAPTION', 'SUP', 'SUB']);
const blocked = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'TEMPLATE', 'SVG', 'MATH',
  'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT', 'LINK', 'META', 'BASE']);

/** Rebuild a small HTML vocabulary; no original element or attribute is inserted. */
export function safeMarkdown(src: string): string {
  const template = document.createElement('template');
  template.innerHTML = marked.parse(src) as string;
  const output = document.createElement('div');
  const safeUrl = (value: string, image: boolean) => {
    try {
      const url = new URL(value, location.href);
      return ['http:', 'https:', ...(image ? [] : ['mailto:'])].includes(url.protocol);
    } catch { return false; }
  };
  const copy = (node: Node, parent: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      parent.appendChild(document.createTextNode(node.textContent || ''));
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const source = node as Element;
    if (source.namespaceURI !== 'http://www.w3.org/1999/xhtml' || blocked.has(source.tagName)) return;
    if (!allowed.has(source.tagName)) {
      for (const child of Array.from(source.childNodes)) copy(child, parent);
      return;
    }
    const clean = document.createElement(source.tagName.toLowerCase());
    const title = source.getAttribute('title');
    if (title) clean.setAttribute('title', title);
    if (source.tagName === 'A') {
      const href = source.getAttribute('href') || '';
      if (href && safeUrl(href, false)) clean.setAttribute('href', href);
      clean.setAttribute('rel', 'noopener noreferrer');
    }
    if (source.tagName === 'IMG') {
      const src = source.getAttribute('src') || '';
      if (src && safeUrl(src, true)) clean.setAttribute('src', src);
      clean.setAttribute('alt', source.getAttribute('alt') || '');
    }
    if (source.tagName === 'TD' || source.tagName === 'TH') {
      for (const name of ['colspan', 'rowspan']) {
        const value = source.getAttribute(name) || '';
        if (/^[1-9]\d{0,2}$/.test(value)) clean.setAttribute(name, value);
      }
    }
    for (const child of Array.from(source.childNodes)) copy(child, clean);
    parent.appendChild(clean);
  };
  for (const node of Array.from(template.content.childNodes)) copy(node, output);
  return output.innerHTML;
}

/** 档案内容和导入材料都按不可信 HTML 处理，保留安全的 Markdown 排版。 */
export default function Markdown({ src }: { src: string }) {
  const html = useMemo(() => safeMarkdown(src), [src]);
  return <div className="md-body" dangerouslySetInnerHTML={{ __html: html }} />;
}
