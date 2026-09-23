// @ts-check
/* global tableau */

/**
 * kqkd-report.js — VIZ: Báo cáo KQKD kiểu "4 nhóm so sánh".
 *
 * Chọn 1 "Năm báo cáo" (dropdown NGAY trong viz) → tự tính & hiển thị 4 khối cột,
 * mỗi khối × 12 tháng:
 *   1) Năm báo cáo            = giá trị tháng của năm Y
 *   2) Cùng kỳ năm trước      = giá trị tháng của năm Y-1
 *   3) Tăng trưởng so kỳ liền kề (MoM%) = (v[Y,m] - v[kỳ trước]) / |v[kỳ trước]|
 *        (kỳ trước của Tháng 1 = Tháng 12 năm Y-1)
 *   4) Tăng trưởng so cùng kỳ năm trước (YoY%) = (v[Y,m] - v[Y-1,m]) / |v[Y-1,m]|
 *
 * VÌ SAO KHÔNG DÙNG FILTER NĂM: filter cắt bỏ dòng của năm trước → không còn dữ liệu
 * để so sánh. Extension nhận dữ liệu NHIỀU NĂM (không filter) rồi tự chọn năm + tính.
 *
 * Đây là "BUILD ZONE": chỉ file này (+ .trex/.html) là code riêng. Không đụng src/core/.
 *
 * Encoding (.trex):
 *   rows    discrete-dimension, 1..5   → chỉ tiêu (nhãn hàng); thả nhiều field = phân cấp cha→con
 *   year    discrete-dimension, 1      → YEAR(date) — date part rời rạc (dễ thả)
 *   month   discrete-dimension, 1      → MONTH hoặc QUARTER(date) — kỳ con, tự nhận 12 tháng/4 quý
 *   value   continuous-measure, 1      → giá trị gốc theo kỳ
 *
 * render(info) — xem src/core/extension.js. DV = { value, formattedValue, nativeValue }.
 * Đổi năm: set biến module `uiReportYear` rồi dispatch 'resize' để core vẽ lại từ data đã cache.
 */

import { initExtension } from '../../core/extension.js';
import { makeFog, parseHex } from '../../core/selection.js';

/* ---- Cấu hình (Configure...) ---- */
const SETTINGS = { cornerLabel: 'kqkd.cornerLabel', headerBg: 'kqkd.headerBg', headerText: 'kqkd.headerText' };
const DEFAULTS = { cornerLabel: 'ĐVT: Triệu VNĐ', headerBg: '#E8770C', headerText: '#FFFFFF' };

/** Năm báo cáo do người dùng chọn trong dropdown (null = mặc định năm mới nhất). */
let uiReportYear = null;

/** DEBUG: đếm số lần render + bật/tắt dòng debug ở đáy. Đặt true khi cần dò lỗi. */
let renderTick = 0;
const DEBUG = false;

const rowHdrWidth = (level) => (level === 0 ? 260 : 150);
const CELL_MIN_W = 76;

const readSetting = (key, fb) => {
  try { const v = tableau.extensions.settings.get(key); return v == null || v === '' ? fb : v; } catch (_e) { return fb; }
};

/* =====================================================================
 * RENDER
 * ===================================================================== */
/** @param {any} info */
function render(info) {
  const { encodedData, encodingMap, selectedMarkIds, styles, bgRgb, container } = info;
  container.innerHTML = '';

  const rowFields = encodingMap?.rows ?? [];
  const yearFields = encodingMap?.year ?? [];
  const monthFields = encodingMap?.month ?? [];
  const valueFields = encodingMap?.value ?? [];

  // ---- GUARD ----
  const need = {
    rows: rowFields.length > 0, year: yearFields.length > 0,
    month: monthFields.length > 0, value: valueFields.length > 0,
  };
  if (!encodedData.length || !need.rows || !need.year || !need.month || !need.value) {
    container.appendChild(emptyState(rowFields, yearFields, monthFields, valueFields, encodedData.length));
    return;
  }

  // ---- Parse + gom dữ liệu: item × (year, sub-period) → {v, f, src} ----
  // sub-period = giá trị shelf "Tháng/Quý": THÁNG (1..12) HOẶC QUÝ (1..4), tùy field user thả.
  const EMPTY = '∅';
  /** @type {Map<string,{path:string[], byYM:Map<string,{v:number,f:string,src:any}>}>} */
  const items = new Map();
  const itemOrder = [];
  const yearsSet = new Set();
  const subSet = new Set();
  /** @type {Map<number,string>} ordinal kỳ con → nhãn hiển thị (formattedValue của field) */
  const subLabels = new Map();
  let badPeriod = 0;

  for (const r of encodedData) {
    const path = (r.rows ?? []).map((dv) => dv?.formattedValue ?? EMPTY);
    const key = path.join('\x00');
    const y = yearNum(r.year?.[0]);
    const s = periodNum(r.month?.[0]);
    if (y == null || s == null) { badPeriod++; continue; }
    const dv = r.value?.[0];
    const num = Number(dv?.value);
    if (!items.has(key)) { items.set(key, { path, byYM: new Map() }); itemOrder.push(key); }
    yearsSet.add(y);
    subSet.add(s);
    if (!subLabels.has(s)) subLabels.set(s, r.month?.[0]?.formattedValue ?? String(s));
    items.get(key).byYM.set(y + '-' + s, {
      v: Number.isFinite(num) ? num : NaN,
      f: dv?.formattedValue ?? (Number.isFinite(num) ? String(num) : ''),
      src: r,
    });
  }

  // Không đọc được Năm/Kỳ → hướng dẫn.
  if (!yearsSet.size || (badPeriod > 0 && badPeriod === encodedData.length)) {
    container.appendChild(periodHint());
    return;
  }

  const years = [...yearsSet].sort((a, b) => a - b);
  const subs = [...subSet].sort((a, b) => a - b);
  // maxSub dùng cho "kỳ liền kề" khi đang ở kỳ ĐẦU năm (Tháng 1 → Tháng 12 năm trước;
  // Quý 1 → Quý 4 năm trước). Suy từ tên field (MONTH→12, QUARTER→4); fallback = max có sẵn.
  const periodName = (monthFields[0]?.name || '').toLowerCase();
  const maxSub = /quarter|quý|quy/.test(periodName) ? 4
    : /month|tháng|thang/.test(periodName) ? 12
    : Math.max(...subs);

  // Sắp itemOrder theo CÂY (cha gom con), giữ thứ tự first-seen ở mỗi cấp → cấp con hiện
  // đúng dưới cấp cha để rowspan gộp cha hoạt động (BUG: cha-con không liền nhau).
  sortHierarchical(itemOrder, items, rowFields.length);

  // Năm báo cáo: theo dropdown nếu hợp lệ, ngược lại năm mới nhất.
  let Y = uiReportYear != null && years.includes(uiReportYear) ? uiReportYear : years[years.length - 1];

  // ---- 4 nhóm cột ----
  const groups = [
    { key: 'G1', kind: 'val', label: `Năm báo cáo (${Y})` },
    { key: 'G2', kind: 'val', label: `Cùng kỳ năm trước (${Y - 1})` },
    { key: 'G3', kind: 'pct', label: 'Tăng trưởng so với kỳ trước (kỳ liền kề)' },
    { key: 'G4', kind: 'pct', label: 'Tăng trưởng so với cùng kỳ năm trước' },
  ];
  /** @type {Array<{gIdx:number,group:any,sub:number}>} */
  const leaves = [];
  groups.forEach((group, gIdx) => subs.forEach((sub) => leaves.push({ gIdx, group, sub })));

  // ---- Cấu hình + theme ----
  const cornerLabel = readSetting(SETTINGS.cornerLabel, DEFAULTS.cornerLabel);
  const headerBg = readSetting(SETTINGS.headerBg, DEFAULTS.headerBg);
  const headerText = readSetting(SETTINGS.headerText, DEFAULTS.headerText);
  const fontFamily = styles?.['font-family'] || styles?.fontFamily || 'inherit';
  const textColor = styles?.color || '#333';
  const fog = makeFog(bgRgb);
  const anySel = selectedMarkIds.size > 0;
  const foggedText = fog(textColor);

  const rowLevels = rowFields.length;

  // ---- Table ----
  const table = document.createElement('table');
  table.className = 'kq-table';
  table.style.fontFamily = fontFamily;
  table.style.color = textColor;
  table.style.setProperty('--kq-hdr-bg', headerBg);
  table.style.setProperty('--kq-hdr-bg2', shade(headerBg, 0.2));
  table.style.setProperty('--kq-hdr-text', headerText);

  const leftOff = [0];
  for (let L = 1; L < rowLevels; L++) leftOff[L] = leftOff[L - 1] + rowHdrWidth(L - 1);

  // ===== THEAD =====
  const thead = table.createTHead();
  // Hàng 0: corner + nhãn nhóm (colspan = số tháng)
  const tr0 = thead.insertRow();
  const corner = document.createElement('th');
  corner.className = 'kq-corner';
  corner.rowSpan = 2;
  corner.colSpan = Math.max(1, rowLevels);
  corner.style.left = '0px';
  const unit = document.createElement('span');
  unit.className = 'kq-unit';
  unit.textContent = cornerLabel;
  corner.appendChild(unit);
  corner.appendChild(buildYearSelect(years, Y));
  tr0.appendChild(corner);

  groups.forEach((group) => {
    const th = document.createElement('th');
    th.className = 'kq-colhdr kq-collvl-0';
    th.colSpan = subs.length;
    th.textContent = group.label;
    th.title = group.label;
    tr0.appendChild(th);
  });
  // Hàng 1: kỳ con (nhãn lấy thẳng từ field: "Tháng 1"… hoặc "Quý 1"…)
  const tr1 = thead.insertRow();
  for (const leaf of leaves) {
    const th = document.createElement('th');
    th.className = 'kq-colhdr';
    const label = subLabels.get(leaf.sub) ?? String(leaf.sub);
    th.textContent = label;
    th.title = label;
    tr1.appendChild(th);
  }

  // ===== TBODY =====
  const tbody = table.createTBody();
  // rowspan cho từng cấp chỉ tiêu
  const spanAt = [];
  for (let L = 0; L < rowLevels; L++) {
    spanAt[L] = new Array(itemOrder.length).fill(0);
    let i = 0;
    while (i < itemOrder.length) {
      const pref = items.get(itemOrder[i]).path.slice(0, L + 1).join('\x00');
      let j = i + 1;
      while (j < itemOrder.length && items.get(itemOrder[j]).path.slice(0, L + 1).join('\x00') === pref) j++;
      spanAt[L][i] = j - i;
      i = j;
    }
  }

  itemOrder.forEach((key, i) => {
    const rec = items.get(key);
    const tr = tbody.insertRow();
    if (i % 2 === 1) tr.className = 'kq-alt';

    for (let L = 0; L < rowLevels; L++) {
      if (spanAt[L][i] > 0) {
        const th = document.createElement('th');
        th.className = 'kq-rowhdr kq-rowlvl-' + L;
        th.rowSpan = spanAt[L][i];
        th.textContent = rec.path[L];
        th.title = rec.path[L];
        th.style.left = leftOff[L] + 'px';
        th.style.minWidth = rowHdrWidth(L) + 'px';
        th.style.maxWidth = rowHdrWidth(L) + 'px';
        th.style.width = rowHdrWidth(L) + 'px';
        tr.appendChild(th);
      }
    }

    for (const leaf of leaves) {
      const cell = tr.insertCell();
      cell.className = 'kq-cell';
      cell.style.minWidth = CELL_MIN_W + 'px';
      const res = computeCell(rec, leaf.group, leaf.sub, Y, maxSub);
      cell.textContent = res.text;
      if (res.cls) cell.classList.add(res.cls);
      if (res.tupleId != null) {
        cell.__data__ = { $tupleId: res.tupleId };
        if (selectedMarkIds.has(res.tupleId)) cell.classList.add('kq-sel');
        else if (anySel) cell.style.color = foggedText;
      }
    }
  });

  const scroll = document.createElement('div');
  scroll.className = 'kq-scroll';
  scroll.appendChild(table);
  container.appendChild(scroll);

  // ---- DEBUG: dòng đáy cho biết extension THỰC SỰ nhận gì (field name + giá trị thô) ----
  if (DEBUG) {
    renderTick++;
    const distinct = [];
    const seen = new Set();
    for (const r of encodedData) {
      const dv = r.month?.[0];
      const k = JSON.stringify([dv?.value, dv?.formattedValue]);
      if (!seen.has(k)) { seen.add(k); distinct.push(`${JSON.stringify(dv?.value)}→"${dv?.formattedValue}"`); }
      if (distinct.length >= 10) break;
    }
    const yr = encodedData.find((r) => r.year?.[0])?.year?.[0];
    const dbg = document.createElement('div');
    dbg.style.cssText =
      'position:fixed;bottom:0;left:0;right:0;font:11px/1.4 monospace;background:#111;' +
      'color:#0f0;padding:4px 8px;z-index:99999;white-space:pre-wrap;max-height:96px;overflow:auto';
    dbg.textContent =
      `[dbg#${renderTick}] year-field="${yearFields[0]?.name}" (vd ${JSON.stringify(yr?.value)}→"${yr?.formattedValue}")  |  kỳ-field="${monthFields[0]?.name}"\n` +
      `kỳ distinct(${distinct.length}): ${distinct.join('   ')}\n` +
      `subs(${subs.length})=[${subs.map((s) => subLabels.get(s)).join(' | ')}]  ·  năm=${years.join('/')} Y=${Y}  ·  dataRows=${encodedData.length}`;
    container.appendChild(dbg);
  }

  // Sticky top offsets = cộng dồn chiều cao thực của các hàng header.
  let top = 0;
  for (const tr of table.tHead.rows) {
    const h = tr.getBoundingClientRect().height;
    for (const c of tr.cells) c.style.top = top + 'px';
    top += h;
  }
}

/* =====================================================================
 * Tính 1 ô theo nhóm + kỳ con (tháng/quý) + năm báo cáo Y.
 * maxSub = kỳ con lớn nhất (12 nếu tháng, 4 nếu quý) — dùng để tìm "kỳ liền kề" đầu năm.
 * @returns {{text:string, cls?:string, tupleId?:number}}
 * ===================================================================== */
function computeCell(rec, group, sub, Y, maxSub) {
  const cur = rec.byYM.get(Y + '-' + sub); // năm báo cáo
  const py = rec.byYM.get(Y - 1 + '-' + sub); // cùng kỳ năm trước
  // kỳ liền kề: kỳ con trước (kỳ đầu năm → kỳ cuối của năm Y-1: Tháng 1→12, Quý 1→4)
  const prev = sub > 1 ? rec.byYM.get(Y + '-' + (sub - 1)) : rec.byYM.get(Y - 1 + '-' + maxSub);

  const numOf = (c) => (c && Number.isFinite(c.v) ? c.v : null);

  if (group.key === 'G1') {
    if (!cur || cur.f === '') return { text: '', cls: 'kq-blank' };
    return { text: cur.f, tupleId: cur.src?.$tupleId };
  }
  if (group.key === 'G2') {
    if (!py || py.f === '') return { text: '', cls: 'kq-blank' };
    return { text: py.f, tupleId: py.src?.$tupleId };
  }
  if (group.key === 'G3') {
    const p = growth(numOf(cur), numOf(prev));
    return pctResult(p, cur?.src?.$tupleId);
  }
  // G4
  const p = growth(numOf(cur), numOf(py));
  return pctResult(p, cur?.src?.$tupleId);
}

/** (cur - base) / |base|. null nếu thiếu dữ liệu hoặc base = 0. */
function growth(cur, base) {
  if (cur == null || base == null || base === 0) return null;
  return (cur - base) / Math.abs(base);
}

function pctResult(p, tupleId) {
  if (p == null) return { text: '–', cls: 'kq-blank' };
  const text = (p >= 0 ? '+' : '') + (p * 100).toFixed(1) + '%';
  return { text, cls: p >= 0 ? 'kq-pct-up' : 'kq-pct-down', tupleId };
}

/* =====================================================================
 * Dropdown chọn năm — đổi năm → set biến module + ép core vẽ lại (dispatch resize).
 * stopPropagation để click vào select không kích hoạt clear-selection của core.
 * ===================================================================== */
function buildYearSelect(years, current) {
  const sel = document.createElement('select');
  sel.className = 'kq-year';
  for (const y of years) {
    const opt = document.createElement('option');
    opt.value = String(y);
    opt.textContent = 'Năm báo cáo: ' + y;
    if (y === current) opt.selected = true;
    sel.appendChild(opt);
  }
  const stop = (e) => e.stopPropagation();
  sel.addEventListener('mousedown', stop);
  sel.addEventListener('click', stop);
  sel.addEventListener('change', (e) => {
    e.stopPropagation();
    const y = parseInt(sel.value, 10);
    if (Number.isFinite(y)) {
      uiReportYear = y;
      window.dispatchEvent(new Event('resize')); // core → doRender (dùng data đã cache)
    }
  });
  return sel;
}

/* =====================================================================
 * Empty-state chẩn đoán + gợi ý period.
 * ===================================================================== */
function emptyState(rowFields, yearFields, monthFields, valueFields, dataRows) {
  const wrap = document.createElement('div');
  wrap.className = 'viz-empty';
  const box = document.createElement('div');
  box.style.textAlign = 'left';
  box.style.maxWidth = '600px';
  box.style.lineHeight = '1.5';

  const h = document.createElement('div');
  h.style.fontWeight = '600';
  h.style.marginBottom = '8px';
  h.textContent = 'Cần đủ 4 shelf CỦA EXTENSION (trong Marks card):';
  box.appendChild(h);

  const ul = document.createElement('ul');
  ul.style.margin = '4px 0 10px 18px';
  const line = (label, need, arr) => {
    const li = document.createElement('li');
    const names = arr.map((f) => f?.name).filter(Boolean);
    const ok = names.length > 0;
    li.textContent = `${ok ? '✓' : '✗'} ${label} — ${need}` + (ok ? ': ' + names.join(', ') : '');
    li.style.color = ok ? '#2e7d32' : '#c62828';
    ul.appendChild(li);
  };
  line('Chỉ tiêu (nhãn hàng)', '1+ dimension (thả cả cấp cha + con để có phân cấp)', rowFields);
  line('Năm (YEAR của ngày)', 'kéo Order Date → YEAR', yearFields);
  line('Tháng/Quý', 'kéo Order Date → MONTH hoặc QUARTER', monthFields);
  line('Giá trị (measure)', '1 measure', valueFields);
  box.appendChild(ul);

  const info = document.createElement('div');
  info.textContent = `Số dòng dữ liệu đọc được: ${dataRows}. ĐỪNG filter theo năm — giữ dữ liệu NHIỀU NĂM để so sánh.`;
  info.style.color = '#a04000';
  box.appendChild(info);

  wrap.appendChild(box);
  return wrap;
}

function periodHint() {
  const wrap = document.createElement('div');
  wrap.className = 'viz-empty';
  wrap.textContent =
    'Không đọc được NĂM/KỲ. Kéo trường ngày (vd Order Date) → YEAR lên shelf "Năm", ' +
    'và Order Date → MONTH hoặc QUARTER lên shelf "Tháng/Quý" (date part rời rạc, pill xanh dương).';
  return wrap;
}

/* =====================================================================
 * Helpers
 * ===================================================================== */

const MONTH_NAMES = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

/** DataValue của YEAR date part → số năm (1900..3000). null nếu không đọc được. */
function yearNum(dv) {
  const v = dv?.value ?? dv?.nativeValue;
  if (typeof v === 'number' && v >= 1900 && v <= 3000) return v;
  if (v instanceof Date) return v.getFullYear();
  const s = (dv?.formattedValue ?? String(v ?? '')).trim();
  const m = s.match(/(\d{4})/);
  if (m) return +m[1];
  const n = parseInt(s, 10);
  return Number.isFinite(n) && n >= 1900 && n <= 3000 ? n : null;
}

/**
 * DataValue của MONTH/QUARTER date part → ordinal kỳ con (tháng 1..12 hoặc quý 1..4).
 * Bền với: số, Date, "Tháng 5"/"Thg 5"/"05"/"5", "Quý 2"/"Q2", hoặc tên tháng tiếng Anh.
 */
function periodNum(dv) {
  const v = dv?.value ?? dv?.nativeValue;
  if (typeof v === 'number' && v >= 1 && v <= 12) return v;
  if (v instanceof Date) return v.getMonth() + 1;
  const s = (dv?.formattedValue ?? String(v ?? '')).trim();
  const digit = s.match(/(\d{1,2})/); // "Tháng 5", "Quý 2", "Q3", "05", "5"
  if (digit) { const n = +digit[1]; if (n >= 1 && n <= 12) return n; }
  const low = s.toLowerCase();
  for (const k in MONTH_NAMES) if (low.startsWith(k)) return MONTH_NAMES[k];
  return null;
}

/**
 * Sắp itemOrder theo CÂY: cha gom con, giữ thứ tự FIRST-SEEN ở từng cấp. Cần thiết để
 * cấp con nằm liền dưới cấp cha (nếu Tableau trả rows không gom theo cha → rowspan vỡ).
 * @param {string[]} order  mảng key (join path bằng \x00) — sắp tại chỗ
 * @param {Map<string,{path:string[]}>} items
 * @param {number} levels
 */
function sortHierarchical(order, items, levels) {
  if (levels < 2) return; // 1 cấp: không cần
  const ord = []; // ord[L] = Map(prefix → thứ tự first-seen)
  for (let L = 0; L < levels; L++) {
    ord[L] = new Map();
    let n = 0;
    for (const key of order) {
      const pref = items.get(key).path.slice(0, L + 1).join('\x00');
      if (!ord[L].has(pref)) ord[L].set(pref, n++);
    }
  }
  order.sort((a, b) => {
    const pa = items.get(a).path;
    const pb = items.get(b).path;
    for (let L = 0; L < levels; L++) {
      const ka = pa.slice(0, L + 1).join('\x00');
      const kb = pb.slice(0, L + 1).join('\x00');
      const d = ord[L].get(ka) - ord[L].get(kb);
      if (d !== 0) return d;
    }
    return 0;
  });
}

/** Trộn màu hex về phía đen theo lượng amt (0..1). */
function shade(hex, amt) {
  const [r, g, b] = parseHex(hex);
  const f = 1 - Math.max(0, Math.min(1, amt));
  const h2 = (n) => Math.round(n * f).toString(16).padStart(2, '0');
  return '#' + h2(r) + h2(g) + h2(b);
}

/* ---- Configure...: nhãn đơn vị + màu header (dùng lại dialog của pivot-table) ---- */
function openConfig() {
  const payload = JSON.stringify({
    cornerLabel: readSetting(SETTINGS.cornerLabel, DEFAULTS.cornerLabel),
    headerBg: readSetting(SETTINGS.headerBg, DEFAULTS.headerBg),
    headerText: readSetting(SETTINGS.headerText, DEFAULTS.headerText),
    zebra: '1',
    defaults: { ...DEFAULTS, zebra: '1' },
  });
  tableau.extensions.ui
    .displayDialogAsync('../pivot-table/pivot-table-config.html', payload, { width: 360, height: 340 })
    .then((closePayload) => {
      if (!closePayload) return;
      let cfg;
      try { cfg = JSON.parse(closePayload); } catch (_e) { return; }
      tableau.extensions.settings.set(SETTINGS.cornerLabel, String(cfg.cornerLabel ?? ''));
      tableau.extensions.settings.set(SETTINGS.headerBg, String(cfg.headerBg ?? DEFAULTS.headerBg));
      tableau.extensions.settings.set(SETTINGS.headerText, String(cfg.headerText ?? DEFAULTS.headerText));
      return tableau.extensions.settings.saveAsync().then(() => window.dispatchEvent(new Event('resize')));
    })
    .catch((err) => {
      if (err && err.errorCode === tableau.ErrorCodes.DialogClosedByUser) return;
      // eslint-disable-next-line no-console
      console.error('[kqkd-report] config dialog error', err);
    });
}

window.onload = () => initExtension({ render, containerId: 'content', configure: openConfig });
