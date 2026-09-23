// @ts-check
/* global tableau */

/**
 * extension.js — "framework mỏng" tái sử dụng cho MỌI viz.
 *
 * Mô hình BUILD ZONE: mỗi viz mới chỉ cần cung cấp một object `view` với hàm
 * `render(info)`. Framework lo toàn bộ phần lặp lại:
 *   initializeAsync → đọc data + encoding → đọc selection → gọi view.render(info)
 *   → tự re-render khi SummaryDataChanged / resize / click / hover.
 *
 * KHÔNG sửa file này khi build viz mới — chỉ viết render() trong <viz>.js.
 *
 * `info` truyền cho render():
 *   {
 *     encodedData:    Array<{ $tupleId, [encodingId]: DataValue[] }>,
 *     encodingMap:    { [encodingId]: Array<{name}> },   // encoding đã có field
 *     rawRows:        Array<{ $tupleId, [fieldName]: DataValue }>,
 *     selectedMarkIds:Set<number>,   // $tupleId đang được chọn
 *     hoveredMarkIds: Set<number>,   // $tupleId đang hover
 *     width, height:  number,        // kích thước container
 *     styles:         Record<string,string>,  // CSS từ workbook formatting
 *     bgRgb:          [number,number,number], // nền (cho fog)
 *     worksheet:      any,           // handle worksheet (dùng cho API nâng cao)
 *     container:      HTMLElement,   // #content — render vào đây
 *   }
 *
 * Quy ước tương tác tự động: renderer BẮT BUỘC bind $tupleId vào mỗi element
 * (D3: .data(rows, d => d.$tupleId) hoặc .datum({...,$tupleId})). Framework đọc
 * lại $tupleId từ element dưới con trỏ để lo select/hover — renderer không cần
 * tự gọi selectTuplesAsync.
 */

import { getSummaryData, getEncodingMap, getEncodedData } from './data.js';
import { getSelectedTupleIds, selectTuples, hoverTuple } from './selection.js';
import { readStyles, worksheetClassName, backgroundRgb } from './theme.js';

/**
 * @typedef {Object} VizView
 * @property {(info: any) => void} render  vẽ viz vào info.container
 * @property {(() => void)} [configure]    optional: mở config dialog (context menu)
 * @property {string} [containerId]        id container (mặc định 'content')
 */

/**
 * Điểm vào chuẩn của một viz extension. Gọi trong window.onload.
 * @param {VizView} view
 */
export function initExtension(view) {
  const initArg = view.configure ? { configure: view.configure } : undefined;

  tableau.extensions.initializeAsync(initArg).then(async () => {
    const worksheet = tableau.extensions.worksheetContent.worksheet;
    const containerId = view.containerId ?? 'content';

    const styles = readStyles();
    const bgRgb = backgroundRgb(styles);

    // State giữ ngoài scope để resize/click không phải fetch lại data.
    /** @type {Array<Record<string, any>>} */
    let rawRows = [];
    /** @type {Record<string, Array<{name:string}>>} */
    let encodingMap = {};
    /** @type {Array<Record<string, any>>} */
    let encodedData = [];
    /** @type {Set<number>} */
    let selectedMarkIds = new Set();
    /** @type {Set<number>} */
    const hoveredMarkIds = new Set();

    const container = document.getElementById(containerId);
    if (!container) {
      // eslint-disable-next-line no-console
      console.error(`[viz] không tìm thấy #${containerId} trong HTML`);
      return;
    }
    container.classList.add(worksheetClassName());

    const doRender = () => {
      view.render({
        encodedData,
        encodingMap,
        rawRows,
        selectedMarkIds,
        hoveredMarkIds,
        width: container.offsetWidth,
        height: container.offsetHeight,
        styles,
        bgRgb,
        worksheet,
        container,
      });
    };

    const updateDataAndRender = async () => {
      [rawRows, encodingMap] = await Promise.all([
        getSummaryData(worksheet),
        getEncodingMap(worksheet),
      ]);
      encodedData = getEncodedData(rawRows, encodingMap);
      selectedMarkIds = await getSelectedTupleIds(worksheet, rawRows);
      doRender();
    };

    // Re-fetch khi data đổi (filter/action/refresh).
    worksheet.addEventListener(
      tableau.TableauEventType.SummaryDataChanged,
      updateDataAndRender
    );

    // Re-render khi theme đổi (API ≥ 1.7). Bọc try để version cũ không crash.
    try {
      worksheet.addEventListener(
        tableau.TableauEventType.WorksheetFormattingChanged,
        doRender
      );
    } catch (_e) {
      /* API < 1.7 — bỏ qua */
    }

    // Resize: chỉ vẽ lại, không fetch.
    window.addEventListener('resize', doRender);

    // Click: đọc $tupleId của element dưới con trỏ → cập nhật selection.
    document.body.addEventListener('click', (e) => {
      handleClick(e, worksheet, selectedMarkIds, hoveredMarkIds, (next) => {
        selectedMarkIds = next;
        doRender();
      });
    });

    // Hover: hiện tooltip gốc Tableau cho mark dưới con trỏ.
    document.body.addEventListener('mousemove', (e) =>
      handleHover(e, worksheet, hoveredMarkIds)
    );
    document.body.addEventListener('mouseleave', () => {
      if (hoveredMarkIds.size) {
        hoveredMarkIds.clear();
        hoverTuple(worksheet, -1);
      }
    });

    await updateDataAndRender();
  });
}

/**
 * Đọc $tupleId từ element DOM dưới con trỏ (qua datum D3).
 * @param {MouseEvent} e
 * @returns {number|null}
 */
function tupleIdUnderPointer(e) {
  const el = document.elementFromPoint(e.pageX, e.pageY);
  if (!el || !(/** @type {any} */ (el).__data__)) return null;
  const datum = /** @type {any} */ (el).__data__;
  const id = datum?.$tupleId ?? datum?.tupleId;
  return typeof id === 'number' ? id : null;
}

/**
 * Logic click: Simple select / Ctrl+toggle / click nền để clear.
 * @param {MouseEvent} e
 * @param {any} worksheet
 * @param {Set<number>} selected
 * @param {Set<number>} hovered
 * @param {(next: Set<number>) => void} commit
 */
function handleClick(e, worksheet, selected, hovered, commit) {
  const tupleId = tupleIdUnderPointer(e);
  const next = new Set(selected);

  if (tupleId !== null) {
    if (next.has(tupleId)) {
      if (next.size === 1) next.clear();
      else if (e.ctrlKey || e.metaKey) next.delete(tupleId);
      else {
        next.clear();
        next.add(tupleId);
      }
    } else {
      if (!(e.ctrlKey || e.metaKey)) next.clear();
      next.add(tupleId);
    }
  } else if (!(e.ctrlKey || e.metaKey)) {
    next.clear();
  }

  hovered.clear();
  selectTuples(worksheet, [...next], { x: e.pageX, y: e.pageY });
  commit(next);
}

/**
 * Logic hover → hoverTupleAsync (tooltip gốc). -1 để clear.
 * @param {MouseEvent} e
 * @param {any} worksheet
 * @param {Set<number>} hovered
 */
function handleHover(e, worksheet, hovered) {
  const tupleId = tupleIdUnderPointer(e);
  const hadHover = hovered.size !== 0;

  if (tupleId !== null) {
    if (!hovered.has(tupleId)) {
      hovered.clear();
      hovered.add(tupleId);
      hoverTuple(worksheet, tupleId, { x: e.pageX, y: e.pageY });
    }
  } else if (hadHover) {
    hovered.clear();
    hoverTuple(worksheet, -1);
  }
}
