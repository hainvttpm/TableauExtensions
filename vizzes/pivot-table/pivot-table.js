// @ts-check
/* global tableau */

/**
 * pivot-table.js — VIZ: BẢNG MA TRẬN (pivot / crosstab) với header cột NHÓM nhiều
 * tầng và header hàng lồng nhau (rowspan). Mẫu cho báo cáo KQKD như ảnh template:
 * cột = "Nhóm so sánh" (Năm báo cáo / Cùng kỳ năm trước / Tăng trưởng...) × "Tháng"
 * (Tháng 1..12); hàng = các chỉ tiêu (Tổng thu thuần / +Thu thuần lãi / ...).
 *
 * Đây là "BUILD ZONE": chỉ file này (+ .trex/.html/-config.html) là code riêng của
 * viz. KHÔNG đụng src/core/ — core lo init/data/encoding/selection/hover/theme.
 *
 * Encoding (khai báo trong .trex):
 *   rows    discrete-dimension, 1..5  → header hàng lồng nhau bên TRÁI (mỗi field = 1 cấp)
 *   cols    discrete-dimension, 0..5  → header cột NHÓM nhiều tầng bên TRÊN
 *   values  measure, 1..N             → giá trị ô; >1 measure → thêm 1 tầng tên measure
 *
 * ĐỔI THỨ TỰ FIELD DÒNG (drag & drop): mỗi field dòng có 1 "chip" tên ở dải header
 * góc trên-trái (thay ô góc gộp cũ). User KÉO-THẢ chip để đảo thứ tự cấp lồng ngay
 * trên bảng. Thứ tự lưu vào workbook settings (SETTINGS.rowOrder = mảng tên field);
 * mỗi lần render áp lại qua hoán vị `perm` — bền vững khi thêm/bớt field trên shelf.
 *
 * render(info) nhận (xem src/core/extension.js để biết đầy đủ):
 *   info.encodedData     Array<{ $tupleId, rows?:DV[], cols?:DV[], values?:DV[] }>
 *   info.encodingMap     { rows?:[{name}], cols?:[{name}], values?:[{name}] }
 *   info.selectedMarkIds Set<number>
 *   info.styles          CSS từ workbook (fontFamily, color, ...)
 *   info.bgRgb           nền [r,g,b] cho fog
 *   info.container       #content — render <table> vào đây
 *
 * DV = { value, formattedValue, nativeValue }. Ô in .formattedValue (Tableau đã
 * format sẵn: "727,324", "41%") → không tự format lại, giữ đúng định dạng workbook.
 *
 * Selection/hover: MỖI ô giá trị = 1 mark (1 tuple). Gán $tupleId lên
 * cell.__data__ để core đọc lại → selectTuplesAsync / hoverTupleAsync. Có selection
 * → fog (làm mờ) chữ các ô chưa chọn.
 */

import { initExtension } from '../../core/extension.js';
import { makeFog, parseHex } from '../../core/selection.js';

/* =====================================================================
 * CẤU HÌNH (Configure...) — lưu trong workbook settings, đọc mỗi lần render.
 * ===================================================================== */
const SETTINGS = {
  cornerLabel: 'pivot.cornerLabel',
  headerBg:    'pivot.headerBg',
  headerText:  'pivot.headerText',
  zebra:       'pivot.zebra',
  rowOrder:    'pivot.rowOrder', // JSON mảng tên field dòng (thứ tự do user kéo-thả)
};
const DEFAULTS = {
  cornerLabel: 'ĐVT: Triệu VNĐ',
  headerBg:    '#E8770C',
  headerText:  '#FFFFFF',
  zebra:       '1',
};

/** Đọc 1 setting (string), fallback default. */
function readSetting(key, fallback) {
  try {
    const v = tableau.extensions.settings.get(key);
    return v == null || v === '' ? fallback : v;
  } catch (_e) {
    return fallback;
  }
}

/** Bề rộng cột nhãn hàng theo cấp (px). Cấp ngoài rộng hơn cho chỉ tiêu dài. */
const rowHdrWidth = (level) => (level === 0 ? 240 : 150);

/** Chiều rộng tối thiểu 1 cột giá trị (px). */
const CELL_MIN_W = 68;

/* =====================================================================
 * RENDER
 * ===================================================================== */

/** @param {any} info */
function render(info) {
  const { encodedData, encodingMap, selectedMarkIds, styles, bgRgb, container } = info;
  container.innerHTML = '';

  const rowFieldsRaw = encodingMap?.rows ?? []; // thứ tự GỐC theo shelf (Tableau trả)
  const colFields = encodingMap?.cols ?? [];
  const measureFields = encodingMap?.values ?? [];

  // Tên field dòng theo thứ tự gốc + hoán vị hiển thị (do user kéo-thả, lưu ở settings).
  // perm[displayLevel] = chỉ số field GỐC → dùng để trích rPath & gán nhãn header.
  const origRowNames = rowFieldsRaw.map((f, i) => f?.name ?? `Row ${i + 1}`);
  const perm = resolveRowPerm(origRowNames, readSetting(SETTINGS.rowOrder, ''));
  const rowFieldNames = perm.map((oi) => origRowNames[oi]); // tên theo thứ tự hiển thị

  // ---- GUARD: cần >=1 measure ở "Values" và >=1 dimension (rows hoặc cols) ----
  const hasAnyDim = rowFieldsRaw.length > 0 || colFields.length > 0;
  if (!encodedData.length || measureFields.length === 0 || !hasAnyDim) {
    container.appendChild(
      emptyState({
        rows: origRowNames.filter(Boolean),
        cols: colFields.map((f) => f?.name).filter(Boolean),
        values: measureFields.map((f) => f?.name).filter(Boolean),
        dataRows: encodedData.length,
      })
    );
    return;
  }

  const measureNames = measureFields.map((f, i) => f?.name ?? `Measure ${i + 1}`);
  const hasCols = colFields.length > 0;
  const multiMeasure = measureFields.length > 1;
  // Hiện tầng header tên measure khi: có nhiều measure, HOẶC không có col dim
  // (khi đó mỗi measure = 1 cột và cần nhãn cho nó).
  const showMeasureLevel = multiMeasure || !hasCols;

  // ---- Gom dữ liệu thành lưới (rowKey × colKey) giữ thứ tự Tableau trả về ----
  const EMPTY = '∅'; // nhãn cho DataValue rỗng (hiếm — dimension luôn có value)
  /** @type {Map<string,{key:string,path:string[]}>} */
  const rowMeta = new Map();
  /** @type {Map<string,{key:string,path:string[]}>} */
  const colMeta = new Map();
  const rowOrder = [];
  const colOrder = [];
  /** @type {Map<string, any>} rowKey \x01 colKey → encodedData row */
  const cellMap = new Map();
  // Rank mỗi giá trị theo THỨ TỰ XUẤT HIỆN gốc, cho từng field dòng (theo chỉ số GỐC).
  // Dùng để sắp lại hàng theo hierarchy MỚI mà vẫn giữ đúng thứ tự sort của mỗi field.
  /** @type {Array<Map<string,number>>} */
  const rankByField = rowFieldsRaw.map(() => new Map());

  for (const r of encodedData) {
    const rRaw = r.rows ?? [];
    // Trích path theo THỨ TỰ HIỂN THỊ (perm), không theo thứ tự gốc của r.rows.
    const rPath = perm.map((oi) => rRaw[oi]?.formattedValue ?? EMPTY);
    const cPath = (r.cols ?? []).map((dv) => dv?.formattedValue ?? EMPTY);
    const rKey = rPath.join('\x00');
    const cKey = cPath.join('\x00');
    if (!rowMeta.has(rKey)) { rowMeta.set(rKey, { key: rKey, path: rPath }); rowOrder.push(rKey); }
    if (!colMeta.has(cKey)) { colMeta.set(cKey, { key: cKey, path: cPath }); colOrder.push(cKey); }
    cellMap.set(rKey + '\x01' + cKey, r); // last-wins nếu trùng (mọi dim nên map vào rows/cols)

    for (let oi = 0; oi < rowFieldsRaw.length; oi++) {
      const v = rRaw[oi]?.formattedValue ?? EMPTY;
      if (!rankByField[oi].has(v)) rankByField[oi].set(v, rankByField[oi].size);
    }
  }

  // Sắp lại rowOrder theo hierarchy HIỂN THỊ: so cấp ngoài→trong (perm), mỗi cấp dùng
  // rank xuất hiện gốc của field đó → hàng cùng nhóm liền nhau, thứ tự bám sort gốc.
  // (perm identity → tái tạo đúng thứ tự Tableau ban đầu.)
  rowOrder.sort((a, b) => {
    const pa = rowMeta.get(a).path;
    const pb = rowMeta.get(b).path;
    for (let L = 0; L < perm.length; L++) {
      const rank = rankByField[perm[L]];
      const ra = rank.get(pa[L]) ?? 0;
      const rb = rank.get(pb[L]) ?? 0;
      if (ra !== rb) return ra - rb;
    }
    return 0;
  });

  // ---- Cột lá (leaf): tổ hợp (colKey × measure). Bỏ tầng measure khi 1 measure + có col. ----
  /** @type {Array<{colKey:string,colPath:string[],mIdx:number}>} */
  const leaves = [];
  if (hasCols) {
    for (const cKey of colOrder) {
      const colPath = colMeta.get(cKey).path;
      if (showMeasureLevel) {
        for (let m = 0; m < measureFields.length; m++) leaves.push({ colKey: cKey, colPath, mIdx: m });
      } else {
        leaves.push({ colKey: cKey, colPath, mIdx: 0 });
      }
    }
  } else {
    // Không có col dim → mỗi measure là 1 cột (colKey = '', colPath = []).
    for (let m = 0; m < measureFields.length; m++) leaves.push({ colKey: '', colPath: [], mIdx: m });
  }

  const numColLevels = colFields.length + (showMeasureLevel ? 1 : 0); // luôn >= 1
  const rowLevels = rowFieldsRaw.length;

  // ---- Cấu hình + theme ----
  const cornerLabel = readSetting(SETTINGS.cornerLabel, DEFAULTS.cornerLabel);
  const headerBg = readSetting(SETTINGS.headerBg, DEFAULTS.headerBg);
  const headerText = readSetting(SETTINGS.headerText, DEFAULTS.headerText);
  const zebra = readSetting(SETTINGS.zebra, DEFAULTS.zebra) !== '0';

  const fontFamily = styles?.['font-family'] || styles?.fontFamily || 'inherit';
  const textColor = styles?.color || '#333';

  const fog = makeFog(bgRgb);
  const anySel = selectedMarkIds.size > 0;
  const foggedText = fog(textColor);

  // ---- Dựng <table> ----
  const table = document.createElement('table');
  table.className = 'pv-table';
  table.style.fontFamily = fontFamily;
  table.style.color = textColor;
  table.style.setProperty('--pv-hdr-bg', headerBg);
  table.style.setProperty('--pv-hdr-bg2', shade(headerBg, 0.2));
  table.style.setProperty('--pv-hdr-text', headerText);

  // Offset dính-trái cho từng cấp header hàng (cộng dồn bề rộng cấp trước).
  const leftOff = [0];
  for (let L = 1; L < rowLevels; L++) leftOff[L] = leftOff[L - 1] + rowHdrWidth(L - 1);

  // Kéo-thả chip: di chuyển field dòng từ vị trí hiển thị `from` → `to`, lưu thứ tự
  // mới (mảng tên) vào settings rồi ép core vẽ lại (dispatch 'resize').
  const onReorder = (from, to) => {
    if (from === to) return;
    const names = perm.map((oi) => origRowNames[oi]);
    const [moved] = names.splice(from, 1);
    names.splice(to, 0, moved);
    const rerender = () => window.dispatchEvent(new Event('resize'));
    try {
      tableau.extensions.settings.set(SETTINGS.rowOrder, JSON.stringify(names));
      tableau.extensions.settings.saveAsync().then(rerender).catch(rerender);
    } catch (_e) {
      rerender();
    }
  };

  buildHead(table, {
    leaves, colFields, numColLevels, rowLevels, showMeasureLevel,
    measureNames, cornerLabel, leftOff, rowFieldNames, onReorder,
  });

  buildBody(table, {
    rowOrder, rowMeta, rowLevels, leaves, cellMap,
    measureFields, selectedMarkIds, anySel, foggedText, zebra, leftOff,
  });

  // ---- Bọc vùng cuộn + gắn vào DOM ----
  const scroll = document.createElement('div');
  scroll.className = 'pv-scroll';
  scroll.appendChild(table);
  container.appendChild(scroll);

  // ---- Sau layout: set `top` dính cho từng hàng header = cộng dồn CHIỀU CAO thực
  //      (đo chính xác, tránh lệch do viền/wrap). Bề rộng cột nhãn đã cố định nên
  //      offset `left` là hằng số → không cần đo. ----
  let top = 0;
  for (const tr of table.tHead.rows) {
    const h = tr.getBoundingClientRect().height;
    for (const cell of tr.cells) cell.style.top = top + 'px';
    top += h;
  }
}

/* =====================================================================
 * THEAD — header cột nhóm nhiều tầng + ô góc (đơn vị).
 * ===================================================================== */
function buildHead(table, ctx) {
  const {
    leaves, colFields, numColLevels, rowLevels, showMeasureLevel,
    measureNames, cornerLabel, leftOff, rowFieldNames, onReorder,
  } = ctx;
  const thead = table.createTHead();

  for (let L = 0; L < numColLevels; L++) {
    const tr = thead.insertRow();

    // Dải góc trên-trái: MỖI field dòng = 1 chip (kéo-thả đổi thứ tự), thay ô góc
    // gộp cũ. Mỗi chip span toàn bộ tầng header (rowSpan) & dính-trái theo leftOff.
    // Chip đầu (cấp 0) mang thêm nhãn đơn vị (cornerLabel) cho khỏi mất.
    if (L === 0 && rowLevels > 0) {
      for (let f = 0; f < rowLevels; f++) {
        const th = document.createElement('th');
        th.className = 'pv-corner pv-fieldhdr';
        th.dataset.level = String(f); // cấp hiển thị — onUp đọc lại làm target
        th.rowSpan = numColLevels;
        th.style.left = leftOff[f] + 'px';
        th.style.minWidth = rowHdrWidth(f) + 'px';
        th.style.maxWidth = rowHdrWidth(f) + 'px';
        th.style.width = rowHdrWidth(f) + 'px';

        const chip = document.createElement('div');
        chip.className = 'pv-chip';
        const grip = document.createElement('span');
        grip.className = 'pv-grip';
        grip.textContent = '⠿';
        const nameEl = document.createElement('span');
        nameEl.className = 'pv-fieldname';
        nameEl.textContent = rowFieldNames[f];
        chip.appendChild(grip);
        chip.appendChild(nameEl);
        chip.title = rowFieldNames[f] + ' — kéo để đổi thứ tự cấp lồng';
        th.appendChild(chip);

        if (f === 0 && cornerLabel) {
          const unit = document.createElement('div');
          unit.className = 'pv-unit';
          unit.textContent = cornerLabel;
          th.appendChild(unit);
        }

        if (rowLevels > 1) attachFieldDrag(th, f, onReorder);
        tr.appendChild(th);
      }
    }

    if (L < colFields.length) {
      // Tầng dimension cột: gộp các leaf liền nhau cùng tiền tố tới cấp L.
      const groups = runs(leaves, (leaf) => leaf.colPath.slice(0, L + 1).join('\x00'));
      for (const grp of groups) {
        const th = document.createElement('th');
        th.className = 'pv-colhdr pv-collvl-' + L;
        th.colSpan = grp.span;
        th.textContent = grp.item.colPath[L];
        th.title = grp.item.colPath[L];
        tr.appendChild(th);
      }
    } else {
      // Tầng tên measure (chỉ khi showMeasureLevel): 1 ô mỗi leaf.
      for (const leaf of leaves) {
        const th = document.createElement('th');
        th.className = 'pv-colhdr pv-meashdr';
        th.textContent = measureNames[leaf.mIdx];
        th.title = measureNames[leaf.mIdx];
        tr.appendChild(th);
      }
    }
  }
  void showMeasureLevel; // (numColLevels đã mã hoá; giữ ký hiệu cho rõ ctx)
}

/* =====================================================================
 * TBODY — hàng dữ liệu; header hàng gộp rowspan; ô giá trị mang $tupleId.
 * ===================================================================== */
function buildBody(table, ctx) {
  const {
    rowOrder, rowMeta, rowLevels, leaves, cellMap,
    measureFields, selectedMarkIds, anySel, foggedText, zebra, leftOff,
  } = ctx;
  const tbody = table.createTBody();

  // rowspan cho từng cấp: span > 0 ở hàng bắt đầu 1 run (cùng tiền tố tới cấp L).
  const spanAt = [];
  for (let L = 0; L < rowLevels; L++) {
    spanAt[L] = new Array(rowOrder.length).fill(0);
    let i = 0;
    while (i < rowOrder.length) {
      const pref = rowMeta.get(rowOrder[i]).path.slice(0, L + 1).join('\x00');
      let j = i + 1;
      while (j < rowOrder.length && rowMeta.get(rowOrder[j]).path.slice(0, L + 1).join('\x00') === pref) j++;
      spanAt[L][i] = j - i;
      i = j;
    }
  }

  rowOrder.forEach((rKey, i) => {
    const tr = tbody.insertRow();
    if (zebra && i % 2 === 1) tr.className = 'pv-alt';
    const rPath = rowMeta.get(rKey).path;

    // Header hàng: chỉ tạo ô nơi 1 run bắt đầu; rowspan lo phần còn lại (HTML tự chừa cột).
    for (let L = 0; L < rowLevels; L++) {
      if (spanAt[L][i] > 0) {
        const th = document.createElement('th');
        th.className = 'pv-rowhdr pv-rowlvl-' + L;
        th.rowSpan = spanAt[L][i];
        th.textContent = rPath[L];
        th.title = rPath[L];
        th.style.left = leftOff[L] + 'px';
        th.style.minWidth = rowHdrWidth(L) + 'px';
        th.style.maxWidth = rowHdrWidth(L) + 'px';
        th.style.width = rowHdrWidth(L) + 'px';
        tr.appendChild(th);
      }
    }

    // Ô giá trị: 1 cell mỗi leaf.
    for (const leaf of leaves) {
      const cell = tr.insertCell();
      cell.className = 'pv-cell';
      cell.style.minWidth = CELL_MIN_W + 'px';

      const dataRow = cellMap.get(rKey + '\x01' + leaf.colKey);
      const dv = dataRow?.values?.[leaf.mIdx];
      const fv = dv?.formattedValue;
      cell.textContent = fv != null && fv !== '' ? fv : dv?.value != null ? String(dv.value) : '';

      if (dataRow) {
        // Gán $tupleId để core đọc lại khi click/hover (bám sát quy ước framework).
        cell.__data__ = { $tupleId: dataRow.$tupleId };
        if (selectedMarkIds.has(dataRow.$tupleId)) {
          cell.classList.add('pv-sel');
        } else if (anySel) {
          cell.style.color = foggedText; // fog: mờ chữ ô chưa chọn
        }
      }
    }
  });

  void measureFields;
}

/* =====================================================================
 * Helpers
 * ===================================================================== */

/**
 * Empty-state CHẨN ĐOÁN: hiện field đang nhận được trên từng shelf + số dòng dữ liệu,
 * để user thấy NGAY field nào đang thiếu / đặt sai chỗ (thay vì 1 câu chung chung).
 * @param {{rows:string[],cols:string[],values:string[],dataRows:number}} d
 * @returns {HTMLElement}
 */
function emptyState(d) {
  const wrap = document.createElement('div');
  wrap.className = 'viz-empty';

  const box = document.createElement('div');
  box.style.textAlign = 'left';
  box.style.maxWidth = '560px';
  box.style.lineHeight = '1.5';

  const h = document.createElement('div');
  h.style.fontWeight = '600';
  h.style.marginBottom = '8px';
  h.textContent = 'Chưa đủ field trên 3 shelf CỦA EXTENSION (trong Marks card):';
  box.appendChild(h);

  const ul = document.createElement('ul');
  ul.style.margin = '4px 0 10px 18px';
  ul.style.padding = '0';
  const line = (label, need, got) => {
    const li = document.createElement('li');
    const ok = got.length > 0;
    li.textContent = `${ok ? '✓' : '✗'} ${label} — ${need}: ` + (ok ? got.join(', ') : '— trống —');
    li.style.color = ok ? '#2e7d32' : '#c62828';
    ul.appendChild(li);
  };
  line('Rows (nhãn hàng)', '1+ dimension', d.rows);
  line('Columns (nhóm cột)', '0+ dimension', d.cols);
  line('Values (giá trị ô)', '1+ measure', d.values);
  box.appendChild(ul);

  const rowsInfo = document.createElement('div');
  rowsInfo.textContent = `Số dòng dữ liệu đọc được: ${d.dataRows}.`;
  box.appendChild(rowsInfo);

  const tip = document.createElement('div');
  tip.style.marginTop = '8px';
  tip.style.color = '#a04000';
  tip.textContent =
    'ĐỪNG dùng "Measure Names / Measure Values". Kéo measure THẲNG lên shelf "Values"; ' +
    'dimension lên "Rows"/"Columns". Field trên Detail sẽ bị bỏ qua.';
  box.appendChild(tip);

  wrap.appendChild(box);
  return wrap;
}

/**
 * Gộp các phần tử LIỀN NHAU có cùng key → [{ key, span, startIdx, item }].
 * Dùng cho colspan (header cột) — leaves đã sắp theo colKey rồi measure nên
 * phần tử cùng tiền tố luôn liền nhau.
 * @template T
 * @param {T[]} items
 * @param {(x:T, i:number)=>string} keyFn
 */
function runs(items, keyFn) {
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const k = keyFn(items[i], i);
    const last = out[out.length - 1];
    if (last && last.key === k) last.span++;
    else out.push({ key: k, span: 1, startIdx: i, item: items[i] });
  }
  return out;
}

/**
 * Trộn màu hex về phía đen theo lượng amt (0..1). Dùng cho tầng cột ngoài đậm hơn.
 * @param {string} hex
 * @param {number} amt
 * @returns {string}
 */
function shade(hex, amt) {
  const [r, g, b] = parseHex(hex);
  const f = 1 - Math.max(0, Math.min(1, amt));
  const h2 = (n) => Math.round(n * f).toString(16).padStart(2, '0');
  return '#' + h2(r) + h2(g) + h2(b);
}

/**
 * Suy ra hoán vị thứ tự HIỂN THỊ của các field dòng từ thứ tự đã lưu.
 * Trả mảng chỉ số GỐC theo thứ tự hiển thị (length = số field dòng).
 * - Bám theo `savedStr` (JSON mảng tên) khi hợp lệ; field còn tồn tại giữ đúng chỗ.
 * - Field MỚI (chưa có trong savedStr) → nối cuối theo thứ tự gốc.
 * - Tên đã lưu nhưng không còn trên shelf → bỏ qua.
 * Luôn trả identity khi savedStr rỗng/hỏng → an toàn tuyệt đối.
 * @param {string[]} origNames  tên field dòng theo thứ tự gốc (shelf)
 * @param {string} savedStr     JSON mảng tên (SETTINGS.rowOrder) hoặc ''
 * @returns {number[]}
 */
function resolveRowPerm(origNames, savedStr) {
  const identity = origNames.map((_v, i) => i);
  if (!savedStr) return identity;

  let saved;
  try { saved = JSON.parse(savedStr); } catch (_e) { return identity; }
  if (!Array.isArray(saved)) return identity;

  const remaining = new Set(identity);
  const perm = [];
  for (const name of saved) {
    for (const oi of remaining) {
      if (origNames[oi] === name) { perm.push(oi); remaining.delete(oi); break; }
    }
  }
  // Field mới (không nằm trong saved) → nối cuối theo thứ tự gốc.
  for (const oi of identity) if (remaining.has(oi)) perm.push(oi);
  return perm;
}

/** Xoá mọi class trạng thái kéo-thả còn sót trong DOM. */
function clearDragMarks() {
  document
    .querySelectorAll('.pv-dragging, .pv-drop-target')
    .forEach((el) => el.classList.remove('pv-dragging', 'pv-drop-target'));
}

/**
 * Chặn ĐÚNG MỘT click ngay sau khi thả (trong 300ms) để core không hiểu thao tác
 * kéo là "click nền" → xoá selection. Tự gỡ nếu không có click nào tới.
 */
function suppressNextClick() {
  const handler = (ev) => {
    ev.stopPropagation();
    ev.stopImmediatePropagation();
    document.removeEventListener('click', handler, true);
  };
  document.addEventListener('click', handler, true);
  setTimeout(() => document.removeEventListener('click', handler, true), 300);
}

/**
 * Gắn kéo-thả bằng POINTER EVENTS (không dùng HTML5 native drag).
 *
 * QUAN TRỌNG: trong Tableau Desktop (nền Chromium), một native drag (draggable +
 * dataTransfer) THOÁT khỏi iframe của extension và bị Tableau bắt như "thả file"
 * → tạo data source rỗng `Dropped_...` → lỗi "Text file has no lines". Dùng
 * mousedown/mousemove/mouseup giữ toàn bộ thao tác TRONG iframe nên Tableau không
 * can thiệp. Chỉ gắn khi có ≥2 field dòng.
 * @param {HTMLElement} th
 * @param {number} level      cấp hiển thị của chip (đọc lại target qua dataset.level)
 * @param {(from:number, to:number)=>void} onReorder
 */
function attachFieldDrag(th, level, onReorder) {
  th.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;      // chỉ chuột trái
    e.preventDefault();              // chặn bôi đen text / native drag
    e.stopPropagation();
    beginPointerDrag(th, level, onReorder);
  });
}

/**
 * Vòng đời một thao tác kéo pointer: theo dõi chip dưới con trỏ, thả → onReorder.
 * @param {HTMLElement} sourceTh
 * @param {number} fromLevel
 * @param {(from:number, to:number)=>void} onReorder
 */
function beginPointerDrag(sourceTh, fromLevel, onReorder) {
  clearDragMarks();
  sourceTh.classList.add('pv-dragging');
  document.body.style.cursor = 'grabbing';
  /** @type {HTMLElement|null} */
  let overTh = null;

  const chipUnder = (x, y) => {
    const el = document.elementFromPoint(x, y);
    const th = el && el.closest ? el.closest('.pv-fieldhdr') : null;
    return th && th !== sourceTh ? /** @type {HTMLElement} */ (th) : null;
  };

  const onMove = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const next = chipUnder(e.clientX, e.clientY);
    if (next !== overTh) {
      if (overTh) overTh.classList.remove('pv-drop-target');
      overTh = next;
      if (overTh) overTh.classList.add('pv-drop-target');
    }
  };

  const cleanup = () => {
    sourceTh.classList.remove('pv-dragging');
    if (overTh) overTh.classList.remove('pv-drop-target');
    document.body.style.cursor = '';
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('mouseup', onUp, true);
    document.removeEventListener('keydown', onKey, true);
    clearDragMarks();
  };

  function onUp(e) {
    e.stopPropagation();
    const target = overTh;
    cleanup();
    if (target) {
      const toLevel = Number(target.dataset.level);
      if (Number.isInteger(toLevel) && toLevel !== fromLevel) {
        suppressNextClick();       // giữ selection qua lần re-render
        onReorder(fromLevel, toLevel);
      }
    }
  }

  function onKey(e) {
    if (e.key === 'Escape') cleanup(); // huỷ kéo
  }

  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('mouseup', onUp, true);
  document.addEventListener('keydown', onKey, true);
}

/* =====================================================================
 * CONFIGURE... — dialog cấu hình nhãn đơn vị + màu header + zebra.
 * ===================================================================== */
function openConfig() {
  const payload = JSON.stringify({
    cornerLabel: readSetting(SETTINGS.cornerLabel, DEFAULTS.cornerLabel),
    headerBg: readSetting(SETTINGS.headerBg, DEFAULTS.headerBg),
    headerText: readSetting(SETTINGS.headerText, DEFAULTS.headerText),
    zebra: readSetting(SETTINGS.zebra, DEFAULTS.zebra),
    defaults: DEFAULTS,
  });

  tableau.extensions.ui
    .displayDialogAsync('./pivot-table-config.html', payload, { width: 360, height: 340 })
    .then((closePayload) => {
      if (!closePayload) return; // Cancel → không lưu
      let cfg;
      try { cfg = JSON.parse(closePayload); } catch (_e) { return; }
      tableau.extensions.settings.set(SETTINGS.cornerLabel, String(cfg.cornerLabel ?? ''));
      tableau.extensions.settings.set(SETTINGS.headerBg, String(cfg.headerBg ?? DEFAULTS.headerBg));
      tableau.extensions.settings.set(SETTINGS.headerText, String(cfg.headerText ?? DEFAULTS.headerText));
      tableau.extensions.settings.set(SETTINGS.zebra, cfg.zebra ? '1' : '0');
      return tableau.extensions.settings.saveAsync().then(() => {
        // Ép core vẽ lại (core lắng nghe 'resize' → doRender). Không đụng src/core/.
        window.dispatchEvent(new Event('resize'));
      });
    })
    .catch((err) => {
      if (err && err.errorCode === tableau.ErrorCodes.DialogClosedByUser) return;
      // eslint-disable-next-line no-console
      console.error('[pivot-table] config dialog error', err);
    });
}

window.onload = () => initExtension({ render, containerId: 'content', configure: openConfig });
