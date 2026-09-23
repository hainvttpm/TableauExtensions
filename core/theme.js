// @ts-check
/* global tableau */

/**
 * theme.js — đọc formatting của workbook để viz khớp theme (font, màu, nền).
 * Tái sử dụng cho MỌI viz.
 *
 * Cách dùng: gắn class tableau.ClassNameKey.Worksheet lên root SVG/container để
 * Tableau tự bơm CSS var; ngoài ra readStyles() trả object cssProperties nếu cần
 * đọc trực tiếp trong renderer (fontFamily, fontSize, color, ...).
 */

/**
 * Đọc CSS properties của worksheet từ environment.workbookFormatting.
 * Trả {} nếu chưa có (một số version/context không cấp).
 * @returns {Record<string, string>}
 */
export function readStyles() {
  const sheet = tableau.extensions.environment.workbookFormatting?.formattingSheets?.find(
    (s) => s.classNameKey === 'tableau-worksheet'
  );
  return sheet?.cssProperties ?? {};
}

/**
 * Class-name key để gắn lên root element cho theming tự động.
 * @returns {string}
 */
export function worksheetClassName() {
  return tableau.ClassNameKey.Worksheet; // 'tableau-worksheet'
}

/**
 * Suy ra màu nền [r,g,b] từ styles (dùng cho fog). Mặc định trắng.
 * @param {Record<string, string>} styles
 * @returns {[number,number,number]}
 */
export function backgroundRgb(styles) {
  const raw = styles?.['background-color'] || styles?.backgroundColor;
  const rgb = parseCssColor(raw);
  return rgb ?? [255, 255, 255];
}

/**
 * Parse màu CSS 'rgb(r,g,b)' / 'rgba(...)' / '#rrggbb' / '#rgb' → [r,g,b] hoặc null.
 * @param {string|undefined} css
 * @returns {[number,number,number]|null}
 */
export function parseCssColor(css) {
  if (!css || typeof css !== 'string') return null;
  const s = css.trim();
  const rgbMatch = s.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (rgbMatch) return [+rgbMatch[1], +rgbMatch[2], +rgbMatch[3]];
  const hex = s.replace(/^#/, '');
  if (hex.length === 3) {
    const n = parseInt(hex.split('').map((c) => c + c).join(''), 16);
    if (!Number.isNaN(n)) return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  if (hex.length === 6) {
    const n = parseInt(hex, 16);
    if (!Number.isNaN(n)) return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  return null;
}
