// @ts-check
/* global tableau */

/**
 * selection.js — khớp mark được chọn ↔ $tupleId, và thuật toán "fog".
 * Tái sử dụng cho MỌI viz. Pattern bám sát MIT sample (Sankey).
 *
 * API không trả tupleId trực tiếp trong getSelectedMarksAsync — nó trả một
 * MarksCollection. Ta khớp ngược về $tupleId bằng value-equality trên MỌI cột
 * (join key nối bằng ký tự \x00).
 */

import { convertToNamedRows } from './data.js';

/**
 * Từ MarksCollection (selected/highlighted) → Set<number> các $tupleId khớp.
 * Viz extension luôn có đúng 1 DataTable trong marksCollection.data.
 * @param {Array<Record<string, any>>} allRows  output getSummaryData (đã reverse)
 * @param {any} marksCollection  từ getSelectedMarksAsync()/getHighlightedMarksAsync()
 * @returns {Set<number>}
 */
export function findIdsOfMarks(allRows, marksCollection) {
  /** @type {Set<number>} */
  const result = new Set();
  if (!marksCollection || marksCollection.data.length === 0) return result;

  const dataTable = marksCollection.data[0];
  const columns = dataTable.columns;

  // key-string của mỗi mark được chọn
  const matchKeys = new Set();
  for (const mark of convertToNamedRows(dataTable, 1)) {
    matchKeys.add(columns.map((c) => mark[c.fieldName].value).join('\x00'));
  }

  // duyệt tất cả hàng, thu $tupleId nơi key khớp
  for (const row of allRows) {
    const key = columns.map((c) => row[c.fieldName].value).join('\x00');
    if (matchKeys.has(key)) result.add(row.$tupleId);
  }
  return result;
}

/**
 * Đọc selection hiện tại của worksheet → Set<$tupleId>.
 * @param {any} worksheet
 * @param {Array<Record<string, any>>} allRows
 * @returns {Promise<Set<number>>}
 */
export async function getSelectedTupleIds(worksheet, allRows) {
  const marks = await worksheet.getSelectedMarksAsync();
  return findIdsOfMarks(allRows, marks);
}

/**
 * Gọi selectTuplesAsync với danh sách $tupleId.
 * @param {any} worksheet
 * @param {number[]} tupleIds
 * @param {{x:number,y:number}} [anchor]  vị trí hiển thị tooltip
 * @param {any} [selectOption=tableau.SelectOptions.Simple]
 */
export function selectTuples(worksheet, tupleIds, anchor, selectOption) {
  return worksheet.selectTuplesAsync(
    tupleIds,
    selectOption ?? tableau.SelectOptions.Simple,
    anchor ? { tooltipAnchorPoint: anchor } : undefined
  );
}

/**
 * Hover một mark (hiện tooltip gốc của Tableau). Truyền -1 để clear.
 * @param {any} worksheet
 * @param {number} tupleId
 * @param {{x:number,y:number}} [anchor]
 */
export function hoverTuple(worksheet, tupleId, anchor) {
  return worksheet.hoverTupleAsync(
    tupleId,
    anchor ? { tooltipAnchorPoint: anchor } : undefined
  );
}

/* =====================================================================
 * FOG — làm mờ các mark KHÔNG được chọn về phía màu nền.
 * Thuật toán port nguyên từ Utils/color.js của MIT repo (không phụ thuộc
 * tinycolor: nhận [r,g,b] và trả '#rrggbb').
 * ===================================================================== */

const DEFAULT_FOG_BLEND = 0.185;
const DARK_FOG_BLEND = 0.275;
const DARK_BG_THRESHOLD = 75;
const CLOSE_TO_WHITE = 245;

/** @param {[number,number,number]} bg */
function fogBlendFactor(bg) {
  const dark = bg[0] <= DARK_BG_THRESHOLD && bg[1] <= DARK_BG_THRESHOLD && bg[2] <= DARK_BG_THRESHOLD;
  return dark ? DARK_FOG_BLEND : DEFAULT_FOG_BLEND;
}

/** @param {number} n */
function hex2(n) {
  const clamped = Math.max(0, Math.min(255, n >>> 0));
  return clamped.toString(16).padStart(2, '0');
}

/**
 * Trả một closure calculateFog(colorHex) cho một màu nền cho trước.
 * @param {[number,number,number]} [bg=[255,255,255]]  nền RGB (mặc định trắng)
 * @returns {(colorHex: string) => string}
 */
export function makeFog(bg = [255, 255, 255]) {
  let [br, bgn, bb] = bg;
  if (br >= CLOSE_TO_WHITE && bgn >= CLOSE_TO_WHITE && bb >= CLOSE_TO_WHITE) {
    br = bgn = bb = CLOSE_TO_WHITE;
  }
  const f = fogBlendFactor(bg);
  const foggedR = ((1 - f) * br) >>> 0;
  const foggedG = ((1 - f) * bgn) >>> 0;
  const foggedB = ((1 - f) * bb) >>> 0;

  return function calculateFog(colorHex) {
    const [r, g, b] = parseHex(colorHex);
    return '#' + hex2((foggedR + r * f) >>> 0) + hex2((foggedG + g * f) >>> 0) + hex2((foggedB + b * f) >>> 0);
  };
}

/**
 * Parse '#rgb' / '#rrggbb' → [r,g,b]. Trả [78,121,167] (xanh mặc định) nếu lỗi.
 * @param {string} hex
 * @returns {[number,number,number]}
 */
export function parseHex(hex) {
  if (typeof hex !== 'string') return [78, 121, 167];
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length !== 6) return [78, 121, 167];
  const n = parseInt(h, 16);
  if (Number.isNaN(n)) return [78, 121, 167];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
