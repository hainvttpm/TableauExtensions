// @ts-check
/* global d3, tableau */

/**
 * radar.js — VIZ: radar / spider chart. Mỗi giá trị Category = 1 TRỤC (spoke);
 * mỗi measure ở shelf "Measures" = 1 ĐA GIÁC (series) phủ lên radar.
 *
 * Đây là "BUILD ZONE": chỉ file này là code riêng của viz. Không đụng src/core/.
 *
 * Encoding (khai báo trong .trex):
 *   category  discrete-dimension, 1 field   → mỗi giá trị = 1 spoke quanh vòng
 *   measures  continuous-measure, 1..N      → mỗi measure = 1 polygon (series)
 *
 * Selection: mỗi category = 1 row = 1 tuple. Các vertex CÙNG 1 spoke (mọi series)
 * đều mang $tupleId của category đó → click/hover bất kỳ vertex nào trên spoke →
 * chọn cả category. Core đọc lại $tupleId từ element.__data__.
 *
 * render(info) nhận (xem src/core/extension.js để biết đầy đủ):
 *   info.encodedData     Array<{ $tupleId, category?:DV[], measures?:DV[] }>
 *   info.encodingMap     { measures?:[{name}], ... }  ← tên series cho legend
 *   info.selectedMarkIds Set<number>
 *   info.width/height    kích thước container
 *   info.styles          CSS từ workbook (fontFamily, color, ...)
 *   info.bgRgb           nền [r,g,b] cho fog
 *   info.container       #content
 *
 * DV = { value, formattedValue, nativeValue }. Dùng .value để tính scale,
 * .formattedValue để in nhãn — Tableau đã format sẵn.
 */

import { initExtension } from '../../core/extension.js';
import { makeFog } from '../../core/selection.js';

// Palette MẶC ĐỊNH: series đầu xám, sau vàng Tableau... user đổi được qua Configure.
// Cycle bằng modulo nếu user thả nhiều measure hơn số màu.
const DEFAULT_COLORS = ['#8a8d8f', '#f2c811', '#2f9e9e', '#e8703a', '#6b5b95', '#4e79a7'];

// Key lưu màu trong workbook settings (1 mảng hex JSON theo THỨ TỰ series).
const COLORS_SETTING_KEY = 'radar.seriesColors';

/**
 * Màu cho series thứ j: ưu tiên màu user đã lưu, fallback default (cycle modulo).
 * @param {string[]} saved  mảng hex đã lưu (có thể rỗng)
 * @param {number} j
 */
function seriesColor(saved, j) {
  return saved[j] || DEFAULT_COLORS[j % DEFAULT_COLORS.length];
}

/** Đọc mảng màu đã lưu từ workbook settings. Trả [] nếu chưa có / lỗi. */
function readSavedColors() {
  try {
    const raw = tableau.extensions.settings.get(COLORS_SETTING_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (_e) {
    return [];
  }
}

/**
 * Mở dialog Configure — 1 ô chọn màu cho mỗi measure. Gọi từ context-menu
 * "Configure..." (core đã forward vào initializeAsync qua view.configure).
 * Dialog trả payload JSON {colors:[...]} → lưu vào settings → SettingsChanged
 * kích hoạt re-render (core lắng nghe qua doRender). Không đụng src/core/.
 */
function openConfig() {
  // Lấy tên series hiện tại từ visual spec để dialog hiện đúng nhãn từng ô màu.
  const worksheet = tableau.extensions.worksheetContent.worksheet;
  worksheet.getVisualSpecificationAsync().then((spec) => {
    let names = [];
    if (spec.activeMarksSpecificationIndex >= 0) {
      const marks = spec.marksSpecifications[spec.activeMarksSpecificationIndex];
      names = marks.encodings
        .filter((e) => e.id === 'measures')
        .map((e) => e.field?.name)
        .filter(Boolean);
    }
    if (!names.length) names = ['Series 1']; // guard: chưa thả measure

    // Truyền màu hiện tại + defaults + tên series sang dialog qua payload để prefill.
    const payload = JSON.stringify({
      colors: readSavedColors(),
      defaults: DEFAULT_COLORS,
      names,
    });

    tableau.extensions.ui
      .displayDialogAsync('./radar-config.html', payload, { width: 340, height: 380 })
      .then((closePayload) => {
        // Cancel → closeDialog('') → payload rỗng: KHÔNG lưu (giữ màu cũ).
        if (!closePayload) return;
        const colors = JSON.parse(closePayload);
        if (!Array.isArray(colors)) return;
        tableau.extensions.settings.set(COLORS_SETTING_KEY, JSON.stringify(colors));
        return tableau.extensions.settings.saveAsync().then(() => {
          // Ép core vẽ lại: nó lắng nghe window 'resize' → doRender → render đọc màu mới.
          // Cách này KHÔNG cần sửa src/core/.
          window.dispatchEvent(new Event('resize'));
        });
      })
      .catch((err) => {
        // Người dùng đóng dialog bằng nút X → API reject; nuốt lỗi đó.
        if (err && err.errorCode === tableau.ErrorCodes.DialogClosedByUser) return;
        // eslint-disable-next-line no-console
        console.error('[radar] config dialog error', err);
      });
  });
}

const MARGIN = 16;       // lề ngoài cùng
const LABEL_PAD = 64;    // chỗ cho nhãn category quanh vòng
const LEGEND_H = 30;     // chiều cao dải legend đáy
const RINGS = 4;         // số vòng lưới đồng tâm

/** @param {any} info */
function render(info) {
  const { encodedData, encodingMap, selectedMarkIds, width, height, styles, bgRgb, container } = info;
  container.innerHTML = '';

  // ---- GUARD: cần category + ít nhất 1 measure ----
  const hasCategory = encodedData.some((r) => r.category?.[0] != null);
  const hasMeasures = (encodingMap?.measures?.length ?? 0) > 0
    && encodedData.some((r) => r.measures?.some((dv) => dv?.value != null));
  if (!encodedData.length || !hasCategory || !hasMeasures) {
    const msg = document.createElement('div');
    msg.className = 'viz-empty';
    msg.textContent =
      'Drop 1 dimension on "Category" (one axis per value) and 1+ measure on ' +
      '"Measures" (one polygon per measure).';
    container.appendChild(msg);
    return;
  }

  const seriesNames = (encodingMap?.measures ?? []).map((f, j) => f?.name ?? `Measure ${j + 1}`);
  const nSeries = seriesNames.length;
  const savedColors = readSavedColors(); // màu user đã cấu hình (nếu có)

  // ---- Chuẩn hoá rows. Giữ value (số, cho scale) + formattedValue (nhãn) ----
  const num = (dv) => {
    const n = Number(dv?.value);
    return Number.isFinite(n) ? n : null;
  };
  const rows = encodedData.map((r) => ({
    $tupleId: r.$tupleId,
    cat: r.category?.[0]?.formattedValue ?? '—',
    vals: (r.measures ?? []).map((dv) => ({ v: num(dv), f: dv?.formattedValue })),
  }));
  const N = rows.length;
  if (N < 3) {
    // Radar cần >= 3 trục mới thành đa giác; ít hơn thì báo nhẹ.
    const msg = document.createElement('div');
    msg.className = 'viz-empty';
    msg.textContent = 'Radar needs at least 3 categories (axes). Add more values on "Category".';
    container.appendChild(msg);
    return;
  }

  const fontFamily = styles?.['font-family'] || styles?.fontFamily || 'inherit';
  const textColor = styles?.color || '#333';

  // ---- Hình học vòng tròn: tâm + bán kính ----
  const plotH = Math.max(0, height - LEGEND_H);
  const cx = width / 2;
  const cy = MARGIN + (plotH - MARGIN) / 2;
  const R = Math.max(0, Math.min(width, plotH) / 2 - MARGIN - LABEL_PAD);

  // Góc mỗi spoke: bắt đầu từ đỉnh (-90°), đi theo chiều kim đồng hồ.
  const angleOf = (i) => -Math.PI / 2 + (i * 2 * Math.PI) / N;
  const pointAt = (i, r) => [cx + r * Math.cos(angleOf(i)), cy + r * Math.sin(angleOf(i))];

  // ---- Thang đo bán kính: 0 (tâm) → max toàn bộ measure ----
  const allVals = rows.flatMap((r) => r.vals.map((c) => c.v)).filter((v) => v != null);
  const maxV = d3.max(allVals) ?? 0;
  const rScale = d3.scaleLinear().domain([0, maxV || 1]).nice().range([0, R]);
  const niceMax = rScale.domain()[1];

  // ---- Fog ----
  const fog = makeFog(bgRgb);
  const anySel = selectedMarkIds.size > 0;
  const vertexFill = (color, tupleId) =>
    anySel && !selectedMarkIds.has(tupleId) ? fog(color) : color;

  // ---- SVG ----
  const svg = d3.create('svg')
    .attr('class', 'tableau-worksheet')
    .attr('width', width).attr('height', height)
    .attr('viewBox', [0, 0, width, height])
    .style('font-family', fontFamily);

  // ---- Lưới: các vòng đồng tâm (đa giác) + số trên trục dọc ----
  const gridG = svg.append('g');
  const ringTicks = rScale.ticks(RINGS).filter((t) => t > 0);
  ringTicks.forEach((t) => {
    const rr = rScale(t);
    const pts = d3.range(N).map((i) => pointAt(i, rr));
    gridG.append('polygon')
      .attr('class', 'radar-grid')
      .attr('points', pts.map((p) => p.join(',')).join(' '))
      .attr('fill', 'none')
      .attr('stroke', textColor)
      .attr('stroke-opacity', 0.18);
    // nhãn giá trị vòng trên spoke đỉnh
    gridG.append('text')
      .attr('class', 'axis-label')
      .attr('x', cx + 3).attr('y', cy - rr)
      .attr('fill', textColor).attr('opacity', 0.55)
      .text(d3.format('~s')(t));
  });

  // ---- Spokes (nan hoa) + nhãn category ----
  const spokeG = svg.append('g');
  rows.forEach((r, i) => {
    const [ox, oy] = pointAt(i, R);
    spokeG.append('line')
      .attr('class', 'radar-spoke')
      .attr('x1', cx).attr('y1', cy).attr('x2', ox).attr('y2', oy)
      .attr('stroke', textColor).attr('stroke-opacity', 0.25);

    // nhãn category ra ngoài vòng, canh lề theo vị trí góc
    const [lx, ly] = pointAt(i, R + 16);
    const cos = Math.cos(angleOf(i));
    const anchor = Math.abs(cos) < 0.3 ? 'middle' : cos > 0 ? 'start' : 'end';
    spokeG.append('text')
      .attr('class', 'axis-label')
      .attr('x', lx).attr('y', ly)
      .attr('text-anchor', anchor)
      .attr('dominant-baseline', 'middle')
      .attr('fill', textColor)
      .attr('font-weight', selectedMarkIds.has(r.$tupleId) ? 'bold' : 'normal')
      .text(r.cat);
  });

  // ---- POLYGONS: mỗi series 1 đa giác phủ (từ SAU ra TRƯỚC để series đầu nổi) ----
  const polyG = svg.append('g');
  for (let j = nSeries - 1; j >= 0; j--) {
    const color = seriesColor(savedColors, j);
    // dùng value (null → 0) cho hình học; polygon luôn khép kín theo mọi spoke
    const pts = rows.map((r, i) => pointAt(i, rScale(r.vals[j]?.v ?? 0)));
    polyG.append('polygon')
      .attr('class', 'radar-poly')
      .attr('points', pts.map((p) => p.join(',')).join(' '))
      .attr('fill', color).attr('fill-opacity', anySel ? 0.12 : 0.28)
      .attr('stroke', color).attr('stroke-width', 2)
      .attr('stroke-opacity', anySel ? 0.5 : 0.9);
  }

  // ---- VERTICES + nhãn giá trị (mỗi vertex mang $tupleId của category) ----
  const dotG = svg.append('g');
  const labelG = svg.append('g');
  for (let j = 0; j < nSeries; j++) {
    const color = seriesColor(savedColors, j);
    rows.forEach((r, i) => {
      const cell = r.vals[j];
      if (!cell || cell.v == null) return;
      const [px, py] = pointAt(i, rScale(cell.v));

      dotG.append('circle')
        .attr('class', 'radar-vertex')
        .each(function (d) { this.__data__ = { $tupleId: r.$tupleId }; }) // bind cho core
        .attr('cx', px).attr('cy', py).attr('r', 3.5)
        .attr('fill', vertexFill(color, r.$tupleId))
        .attr('stroke', '#fff').attr('stroke-width', 1);

      // nhãn trong ô bo góc, đẩy ra ngoài tâm 1 chút; series lệch nhau theo dy
      const label = cell.f ?? d3.format('~s')(cell.v);
      const nx = px - cx, ny = py - cy;
      const mag = Math.hypot(nx, ny) || 1;
      const lx = px + (nx / mag) * 12;
      const ly = py + (ny / mag) * 12 + (j - (nSeries - 1) / 2) * 14;
      const w = String(label).length * 7 + 8;
      const gEl = labelG.append('g');
      gEl.append('rect')
        .attr('class', 'value-label-bg')
        .attr('x', lx - w / 2).attr('y', ly - 10)
        .attr('width', w).attr('height', 16).attr('rx', 3)
        .attr('fill', color).attr('opacity', anySel && !selectedMarkIds.has(r.$tupleId) ? 0.25 : 0.85);
      gEl.append('text')
        .attr('class', 'value-label')
        .attr('x', lx).attr('y', ly + 1)
        .attr('text-anchor', 'middle')
        .attr('font-weight', 'bold')
        .attr('fill', labelInk(color))
        .text(label);
    });
  }

  // ---- Legend (đáy, canh giữa) ----
  const legendG = svg.append('g');
  const items = seriesNames.map((name, j) => ({
    name, color: seriesColor(savedColors, j),
    w: 16 + String(name).length * 6.6 + 22,
  }));
  const totalW = items.reduce((a, it) => a + it.w, 0);
  let lx = cx - totalW / 2;
  const ly = height - LEGEND_H / 2;
  items.forEach((it) => {
    legendG.append('rect')
      .attr('x', lx).attr('y', ly - 6).attr('width', 12).attr('height', 12).attr('rx', 2)
      .attr('fill', it.color);
    legendG.append('text')
      .attr('class', 'legend-label')
      .attr('x', lx + 16).attr('y', ly + 4)
      .attr('fill', textColor)
      .text(it.name);
    lx += it.w;
  });

  container.appendChild(svg.node());
}

/**
 * Chọn màu chữ tương phản trên nền ô nhãn (đen trên vàng/sáng, trắng trên xám/tối).
 * @param {string} hex
 */
function labelInk(hex) {
  const h = hex.replace('#', '');
  if (h.length !== 6) return '#333';
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? '#333' : '#fff';
}

// configure: hiện menu "Configure..." trên extension → mở dialog chọn màu.
window.onload = () => initExtension({ render, containerId: 'content', configure: openConfig });
