// @ts-check
/* global tableau */

/**
 * kqkd-measures.js — VIZ: Báo cáo KQKD "đa measure".
 *
 * Khác với kqkd-report ở chỗ: DÒNG = TÊN MEASURE (mỗi measure thả vào = 1 dòng), hợp
 * với P&L nơi mỗi chỉ tiêu là 1 measure riêng. Cột vẫn là 4 nhóm × kỳ (tự tính):
 *   Năm báo cáo / Cùng kỳ năm trước / MoM% (kỳ liền kề) / YoY% (cùng kỳ năm trước).
 *
 * NĂM BÁO CÁO đọc từ **Tableau Parameter** (control trên dashboard) — viz extension
 * ĐỌC ĐƯỢC parameter (findParameterAsync) và nghe ParameterChanged. KHÔNG dùng data
 * filter theo năm (filter xoá dòng năm trước → mất dữ liệu so sánh). Nếu không tìm thấy
 * parameter năm, fallback về dropdown chọn năm ngay trong viz.
 *
 * "BUILD ZONE": chỉ file này (+ .trex/.html) là code riêng. Không đụng src/core/.
 *
 * Encoding (.trex):
 *   measures  continuous-measure, 1..N  → mỗi measure = 1 DÒNG
 *   year      discrete-dimension, 1      → YEAR(date) — năm dữ liệu của mark
 *   period    discrete-dimension, 1      → MONTH/QUARTER(date) — kỳ con
 */

import { initExtension } from '../../core/extension.js';
import { makeFog, parseHex } from '../../core/selection.js';

/* ---- Cấu hình (Configure...) — dùng lại dialog của pivot-table ---- */
const SETTINGS = { cornerLabel: 'kqkdm.cornerLabel', headerBg: 'kqkdm.headerBg', headerText: 'kqkdm.headerText', yearParam: 'kqkdm.yearParam' };
const DEFAULTS = { cornerLabel: 'ĐVT: Triệu VNĐ', headerBg: '#E8770C', headerText: '#FFFFFF' };

/** Năm chọn qua dropdown trong viz (fallback khi không có parameter). */
let uiReportYear = null;
/** Năm đọc từ Tableau Parameter (null = chưa/không có). */
let paramYear = null;
/** Tên parameter năm đã gắn (để hiện chú thích). */
let paramName = null;
/** Đã gắn listener parameter chưa (chỉ làm 1 lần). */
let paramWired = false;

const rowHdrWidth = 300;
const CELL_MIN_W = 76;

const readSetting = (key, fb) => {
  try { const v = tableau.extensions.settings.get(key); return v == null || v === '' ? fb : v; } catch (_e) { return fb; }
};

/* =====================================================================
 * PARAMETER năm — đọc + nghe thay đổi. Chạy 1 lần (render đầu).
 * ===================================================================== */
function isYearVal(dv) {
  const n = parseInt(dv?.value ?? dv?.nativeValue ?? dv?.formattedValue, 10);
  return Number.isFinite(n) && n >= 1900 && n <= 3000 ? n : null;
}

function wireYearParam(worksheet) {
  if (!worksheet || typeof worksheet.getParametersAsync !== 'function') return; // API cũ → dùng dropdown
  const configured = readSetting(SETTINGS.yearParam, '').trim();
  worksheet
    .getParametersAsync()
    .then((params) => {
      let p = null;
      if (configured) p = params.find((x) => x.name === configured);
      // ưu tiên tên có "năm/year" và giá trị giống năm
      if (!p) p = params.find((x) => /năm|nam|year/i.test(x.name) && isYearVal(x.currentValue) != null);
      // hoặc bất kỳ parameter nào có giá trị giống năm
      if (!p) p = params.find((x) => isYearVal(x.currentValue) != null);
      if (!p) return; // không có → fallback dropdown
      paramName = p.name;
      paramYear = isYearVal(p.currentValue);
      try {
        p.addEventListener(tableau.TableauEventType.ParameterChanged, (e) => {
          const done = (np) => { paramYear = isYearVal(np.currentValue); window.dispatchEvent(new Event('resize')); };
          if (e && typeof e.getParameterAsync === 'function') e.getParameterAsync().then(done);
          else done(p);
        });
      } catch (_e) { /* version cũ có thể không hỗ trợ addEventListener trên parameter */ }
      window.dispatchEvent(new Event('resize')); // vẽ lại với năm từ parameter
    })
    .catch(() => { /* getParametersAsync lỗi → fallback dropdown */ });
}

/* =====================================================================
 * RENDER
 * ===================================================================== */
/** @param {any} info */
function render(info) {
  const { encodedData, encodingMap, selectedMarkIds, styles, bgRgb, container, worksheet } = info;
  container.innerHTML = '';

  if (!paramWired) { paramWired = true; wireYearParam(worksheet); }

  const measureFields = encodingMap?.measures ?? [];
  const yearFields = encodingMap?.year ?? [];
  const periodFields = encodingMap?.period ?? [];

  // ---- GUARD ----
  if (!encodedData.length || !measureFields.length || !yearFields.length || !periodFields.length) {
    container.appendChild(emptyState(measureFields, yearFields, periodFields, encodedData.length));
    return;
  }

  // ---- Parse: mỗi measure → 1 "hàng" với byYM(year-sub → {v,f,src}) ----
  // period = 1..N date-part (ngoài→trong). Cấp TRONG CÙNG (lastIdx) = mức so sánh (ordinal).
  const measureNames = measureFields.map((f, i) => f?.name ?? `Measure ${i + 1}`);
  const perMeasure = measureNames.map((n) => ({ name: n, byYM: new Map() }));
  const lastIdx = periodFields.length - 1;
  const yearsSet = new Set();
  const subSet = new Set();
  const subMeta = new Map(); // ordinal(cấp trong cùng) → path nhãn [ngoài..trong]
  let bad = 0;

  for (const r of encodedData) {
    const y = yearNum(r.year?.[0]);
    const pv = r.period ?? [];
    const s = periodNum(pv[lastIdx]); // cấp trong cùng
    if (y == null || s == null) { bad++; continue; }
    yearsSet.add(y);
    subSet.add(s);
    if (!subMeta.has(s)) subMeta.set(s, pv.map((dv) => dv?.formattedValue ?? '∅'));
    const vals = r.measures ?? [];
    for (let m = 0; m < perMeasure.length; m++) {
      const dv = vals[m];
      const num = Number(dv?.value);
      perMeasure[m].byYM.set(y + '-' + s, {
        v: Number.isFinite(num) ? num : NaN,
        f: dv?.formattedValue ?? (Number.isFinite(num) ? String(num) : ''),
        src: r,
      });
    }
  }

  if (!yearsSet.size || (bad > 0 && bad === encodedData.length)) {
    container.appendChild(periodHint());
    return;
  }

  const years = [...yearsSet].sort((a, b) => a - b);
  const subs = [...subSet].sort((a, b) => a - b);
  const periodName = (periodFields[lastIdx]?.name || '').toLowerCase(); // cấp trong cùng quyết định maxSub
  const maxSub = /quarter|quý|quy/.test(periodName) ? 4 : /month|tháng|thang/.test(periodName) ? 12 : Math.max(...subs);

  // Năm báo cáo: parameter (nếu có) > dropdown > năm mới nhất.
  const paramBound = paramYear != null;
  let Y = paramBound
    ? paramYear
    : uiReportYear != null && years.includes(uiReportYear) ? uiReportYear : years[years.length - 1];

  const groups = [
    { key: 'G1', kind: 'val', label: `Năm báo cáo (${Y})` },
    { key: 'G2', kind: 'val', label: `Cùng kỳ năm trước (${Y - 1})` },
    { key: 'G3', kind: 'pct', label: 'Tăng trưởng so với kỳ trước (kỳ liền kề)' },
    { key: 'G4', kind: 'pct', label: 'Tăng trưởng so với cùng kỳ năm trước' },
  ];
  // Cột lá (group-major): mỗi (group × sub cấp-trong-cùng) = 1 cột.
  const leaves = [];
  groups.forEach((group, gi) => subs.forEach((sub) => leaves.push({ gi, group, sub })));

  // ---- Cấu hình + theme ----
  const cornerLabel = readSetting(SETTINGS.cornerLabel, DEFAULTS.cornerLabel);
  const headerBg = readSetting(SETTINGS.headerBg, DEFAULTS.headerBg);
  const headerText = readSetting(SETTINGS.headerText, DEFAULTS.headerText);
  const fontFamily = styles?.['font-family'] || styles?.fontFamily || 'inherit';
  const textColor = styles?.color || '#333';
  const fog = makeFog(bgRgb);
  const anySel = selectedMarkIds.size > 0;
  const foggedText = fog(textColor);

  const table = document.createElement('table');
  table.className = 'kq-table';
  table.style.fontFamily = fontFamily;
  table.style.color = textColor;
  table.style.setProperty('--kq-hdr-bg', headerBg);
  table.style.setProperty('--kq-hdr-bg2', shade(headerBg, 0.2));
  table.style.setProperty('--kq-hdr-text', headerText);

  // ===== THEAD ===== (1 hàng Nhóm + N hàng cấp kỳ: Nhóm → Quý → Tháng…)
  const numColLevels = 1 + periodFields.length;
  const thead = table.createTHead();
  for (let L = 0; L < numColLevels; L++) {
    const tr = thead.insertRow();
    if (L === 0) {
      const corner = document.createElement('th');
      corner.className = 'kq-corner';
      corner.rowSpan = numColLevels;
      corner.style.left = '0px';
      const unit = document.createElement('span');
      unit.className = 'kq-unit';
      unit.textContent = cornerLabel;
      corner.appendChild(unit);
      if (paramBound) {
        const note = document.createElement('span');
        note.className = 'kq-paramnote';
        note.textContent = `Năm báo cáo: ${Y}  (theo parameter «${paramName}»)`;
        corner.appendChild(note);
      } else {
        corner.appendChild(buildYearSelect(years, Y));
      }
      tr.appendChild(corner);
      // Hàng Nhóm: mỗi nhóm span toàn bộ cột kỳ.
      groups.forEach((group) => {
        const th = document.createElement('th');
        th.className = 'kq-colhdr kq-collvl-0';
        th.colSpan = subs.length;
        th.textContent = group.label;
        th.title = group.label;
        tr.appendChild(th);
      });
    } else {
      // Cấp kỳ pl: gộp các leaf liền nhau cùng (nhóm, tiền tố path tới pl).
      const pl = L - 1;
      const rr = runs(leaves, (leaf) => leaf.gi + '\x01' + (subMeta.get(leaf.sub) || []).slice(0, pl + 1).join('\x00'));
      for (const run of rr) {
        const th = document.createElement('th');
        th.className = 'kq-colhdr';
        const path = subMeta.get(run.item.sub) || [];
        const lbl = path[pl] ?? String(run.item.sub);
        th.colSpan = run.span;
        th.textContent = lbl;
        th.title = lbl;
        tr.appendChild(th);
      }
    }
  }

  // ===== TBODY: mỗi measure = 1 dòng =====
  const tbody = table.createTBody();
  perMeasure.forEach((rec, i) => {
    const tr = tbody.insertRow();
    if (i % 2 === 1) tr.className = 'kq-alt';

    const th = document.createElement('th');
    th.className = 'kq-rowhdr';
    th.textContent = rec.name;
    th.title = rec.name;
    th.style.left = '0px';
    th.style.minWidth = rowHdrWidth + 'px';
    th.style.maxWidth = rowHdrWidth + 'px';
    th.style.width = rowHdrWidth + 'px';
    tr.appendChild(th);

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

  // Sticky top offsets
  let top = 0;
  for (const tr of table.tHead.rows) {
    const h = tr.getBoundingClientRect().height;
    for (const c of tr.cells) c.style.top = top + 'px';
    top += h;
  }
}

/**
 * Gộp phần tử LIỀN NHAU cùng key → [{key, span, item}]. Dùng cho colspan header kỳ lồng cấp.
 */
function runs(items, keyFn) {
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const k = keyFn(items[i], i);
    const last = out[out.length - 1];
    if (last && last.key === k) last.span++;
    else out.push({ key: k, span: 1, item: items[i] });
  }
  return out;
}

/* =====================================================================
 * Tính 1 ô — GIỐNG kqkd-report (dùng rec.byYM của measure).
 * ===================================================================== */
function computeCell(rec, group, sub, Y, maxSub) {
  const cur = rec.byYM.get(Y + '-' + sub);
  const py = rec.byYM.get(Y - 1 + '-' + sub);
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
  if (group.key === 'G3') return pctResult(growth(numOf(cur), numOf(prev)), cur?.src?.$tupleId);
  return pctResult(growth(numOf(cur), numOf(py)), cur?.src?.$tupleId);
}

function growth(cur, base) {
  if (cur == null || base == null || base === 0) return null;
  return (cur - base) / Math.abs(base);
}
function pctResult(p, tupleId) {
  if (p == null) return { text: '–', cls: 'kq-blank' };
  return { text: (p >= 0 ? '+' : '') + (p * 100).toFixed(1) + '%', cls: p >= 0 ? 'kq-pct-up' : 'kq-pct-down', tupleId };
}

/* ---- Dropdown năm (fallback khi không có parameter) ---- */
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
    if (Number.isFinite(y)) { uiReportYear = y; window.dispatchEvent(new Event('resize')); }
  });
  return sel;
}

/* ---- Empty-state / hints ---- */
function emptyState(measureFields, yearFields, periodFields, dataRows) {
  const wrap = document.createElement('div');
  wrap.className = 'viz-empty';
  const box = document.createElement('div');
  box.style.cssText = 'text-align:left;max-width:620px;line-height:1.5';
  const h = document.createElement('div');
  h.style.cssText = 'font-weight:600;margin-bottom:8px';
  h.textContent = 'Cần đủ 3 shelf CỦA EXTENSION (trong Marks card):';
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
  line('Chỉ tiêu = Measures', '1+ measure (mỗi measure 1 dòng)', measureFields);
  line('Năm (YEAR của ngày)', 'kéo Order Date → YEAR', yearFields);
  line('Tháng/Quý', 'kéo Order Date → MONTH hoặc QUARTER', periodFields);
  box.appendChild(ul);
  const info = document.createElement('div');
  info.style.color = '#a04000';
  info.textContent = `Số dòng dữ liệu: ${dataRows}. Năm báo cáo lấy từ PARAMETER (control trên dashboard) — ĐỪNG filter theo năm (giữ dữ liệu nhiều năm).`;
  box.appendChild(info);
  wrap.appendChild(box);
  return wrap;
}
function periodHint() {
  const wrap = document.createElement('div');
  wrap.className = 'viz-empty';
  wrap.textContent =
    'Không đọc được NĂM/KỲ. Kéo Order Date → YEAR lên "Năm", và Order Date → MONTH hoặc QUARTER lên "Tháng/Quý" (date part rời rạc, pill xanh dương).';
  return wrap;
}

/* ---- Helpers ---- */
const MONTH_NAMES = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

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
function periodNum(dv) {
  const v = dv?.value ?? dv?.nativeValue;
  if (typeof v === 'number' && v >= 1 && v <= 12) return v;
  if (v instanceof Date) return v.getMonth() + 1;
  const s = (dv?.formattedValue ?? String(v ?? '')).trim();
  const digit = s.match(/(\d{1,2})/);
  if (digit) { const n = +digit[1]; if (n >= 1 && n <= 12) return n; }
  const low = s.toLowerCase();
  for (const k in MONTH_NAMES) if (low.startsWith(k)) return MONTH_NAMES[k];
  return null;
}
function shade(hex, amt) {
  const [r, g, b] = parseHex(hex);
  const f = 1 - Math.max(0, Math.min(1, amt));
  const h2 = (n) => Math.round(n * f).toString(16).padStart(2, '0');
  return '#' + h2(r) + h2(g) + h2(b);
}

/* ---- Configure...: dùng lại dialog của pivot-table (nhãn đơn vị + màu header) ---- */
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
      console.error('[kqkd-measures] config error', err);
    });
}

window.onload = () => initExtension({ render, containerId: 'content', configure: openConfig });
