// @ts-check
/* global d3 */

/**
 * combo-bar-lines.js — VIZ: cụm cột (grouped bars) + nhiều đường (multi-line),
 * DUAL AXIS (bars = trục trái, lines = trục phải), có super-group tùy chọn.
 *
 * Đây là "BUILD ZONE": chỉ file này là code riêng của viz. Không đụng src/core/.
 *
 * Vì sao cần viz extension thay vì dual-axis built-in:
 *   Muốn CỤM nhiều bar phải đặt Measure Names lên Columns, nhưng Measure Names là
 *   dùng chung toàn viz → nó chẻ luôn trục line thành cột rời, line không nối liền.
 *   Chỉ có 1 field Measure Names nên không tách bar-axis và line-axis. → vẽ tay D3.
 *
 * Encoding (khai báo trong .trex):
 *   category  discrete-dimension, 1 field   → mỗi giá trị = 1 cụm cột + 1 điểm mỗi line
 *   group     discrete-dimension, 1..N field → HIERARCHY: mỗi field = 1 level. Level hiện
 *                                              tại = các khối; bấm nhãn khối để DRILL xuống
 *                                              level kế (breadcrumb để lên lại). 1 field =
 *                                              super-group như cũ (không drill).
 *   bars      continuous-measure, 1..N      → CỤM cột, TRỤC TRÁI (giá trị tuyệt đối)
 *   lines     continuous-measure, 1..N      → nhiều ĐƯỜNG, TRỤC PHẢI (thường là %)
 *
 * render(info) nhận (xem src/core/extension.js để biết đầy đủ):
 *   info.encodedData     Array<{ $tupleId, category?:DV[], group?:DV[], bars?:DV[], lines?:DV[] }>
 *   info.encodingMap     { bars?:[{name}], lines?:[{name}], ... }  ← tên series cho legend
 *   info.selectedMarkIds Set<number>
 *   info.width/height    kích thước container
 *   info.styles          CSS từ workbook (fontFamily, color, ...)
 *   info.bgRgb           nền [r,g,b] cho fog
 *   info.container       #content
 *
 * DV = { value, formattedValue, nativeValue }. Ta dùng .value để tính scale,
 * .formattedValue để in nhãn ("727,324", "41%") — Tableau đã format sẵn.
 *
 * Selection: mỗi category = 1 row = 1 tuple. Click bất kỳ cột/điểm nào của một
 * category → chọn nguyên tuple đó. Mỗi element mang $tupleId (core đọc lại để
 * selectTuplesAsync / hoverTupleAsync).
 *
 * Drill (Group = hierarchy): Tableau chỉ trả dữ liệu CẤP LÁ (category × mọi level).
 * Ở cấp chưa sâu nhất ta tự gộp: Bars=SUM (đúng), Lines=AVG (xấp xỉ cho %/tỷ lệ);
 * ở cấp lá mỗi ô = 1 row nên giá trị chính xác tuyệt đối. Bấm nhãn khối → drillPath
 * dài thêm 1; breadcrumb "Tất cả › …" bấm để lên lại. drillPath giữ NGOÀI render().
 */

import { initExtension } from '../../core/extension.js';
import { makeFog } from '../../core/selection.js';

// Palette gợi cảm hứng từ báo cáo ngân hàng (bars ấm/xám, lines tương phản).
// Cycle bằng modulo nếu user thả nhiều measure hơn số màu.
const BAR_COLORS  = ['#f2c811', '#8a8d8f', '#b7a642', '#cfd1d2', '#e8973a', '#6b8fb5'];
const LINE_COLORS = ['#2f9e9e', '#a3b545', '#e8703a', '#6b5b95', '#4e79a7', '#c14b4b'];

const MARGIN = { top: 30, right: 56, left: 64 };
const CAT_LABEL_H = 44;   // chỗ cho nhãn category (xoay)
const GAP_UNITS   = 0.7;  // bề rộng khoảng trống giữa 2 group (đơn vị = 1 slot category)
const CAT_PAD     = 0.28; // padding hai bên trong 1 slot category (cho cụm cột)

// ---- Trạng thái DRILL: sống NGOÀI render() để giữ qua mỗi lần vẽ lại ----
// drillPath[i] = giá trị đã drill ở level i (dùng formattedValue để so khớp).
let drillPath = [];
// info mới nhất từ core — để tự re-render sau khi drill mà không cần chờ sự kiện.
let latestInfo = null;

/** @param {any} info */
function render(info) {
  latestInfo = info;                        // nhớ info mới nhất cho lần drill kế
  const { encodedData, encodingMap, selectedMarkIds, width, height, styles, bgRgb, container } = info;
  container.innerHTML = '';
  const redraw = () => render(latestInfo);  // gọi sau khi đổi drillPath

  // ---- GUARD: cần category + ít nhất 1 measure ở shelf Bars ----
  const hasCategory = encodedData.some((r) => r.category?.[0] != null);
  const hasBars = (encodingMap?.bars?.length ?? 0) > 0
    && encodedData.some((r) => r.bars?.some((dv) => dv?.value != null));
  if (!encodedData.length || !hasCategory || !hasBars) {
    const msg = document.createElement('div');
    msg.className = 'viz-empty';
    msg.textContent =
      'Drop 1 dimension on "Category", 1+ measure on "Bars" (left axis), and ' +
      '(optional) 1+ measure on "Lines" (right axis). Drop a HIERARCHY on "Group" ' +
      '(1+ levels) then click a group label to drill down.';
    container.appendChild(msg);
    return;
  }

  const barNames = (encodingMap?.bars ?? []).map((f, j) => f?.name ?? `Bars ${j + 1}`);
  const lineNames = (encodingMap?.lines ?? []).map((f, j) => f?.name ?? `Lines ${j + 1}`);
  const nBars = barNames.length;
  const nLines = lineNames.length;

  // Group giờ là HIERARCHY: 1..N level (thứ tự shelf = trên→dưới của hierarchy).
  const nLevels = encodingMap?.group?.length ?? 0;
  const hasGroup = nLevels > 0 && encodedData.some((r) => r.group?.[0] != null);

  // ---- Row cấp LÁ: granularity Tableau trả = category × MỌI level của group ----
  const num = (dv) => {
    const n = Number(dv?.value);
    return Number.isFinite(n) ? n : null;
  };
  const leaf = encodedData.map((r) => ({
    $tupleId: r.$tupleId,
    cat: r.category?.[0]?.formattedValue ?? '—',
    levels: hasGroup ? (r.group ?? []).map((dv) => dv?.formattedValue ?? '—') : [],
    bars: (r.bars ?? []).map((dv) => ({ v: num(dv), f: dv?.formattedValue })),
    lines: (r.lines ?? []).map((dv) => ({ v: num(dv), f: dv?.formattedValue })),
  }));

  // ---- DRILL: giữ drillPath hợp lệ với dữ liệu hiện tại ----
  // Không drill quá level áp chót (level cuối là lá, hết con). Nếu data đổi (filter)
  // làm path không còn khớp → cắt bớt tới prefix còn khớp.
  if (!hasGroup) {
    drillPath = [];
  } else {
    if (drillPath.length > nLevels - 1) drillPath = drillPath.slice(0, nLevels - 1);
    while (drillPath.length > 0
      && !leaf.some((r) => drillPath.every((v, i) => r.levels[i] === v))) {
      drillPath = drillPath.slice(0, -1);
    }
  }
  const curLevel = drillPath.length; // level đang hiển thị thành các "khối group"

  // ---- Lọc theo path + GỘP lên level hiện tại → rows {cat, group, bars[], lines[]} ----
  // Cấp chưa sâu nhất: tự gộp Bars=SUM, Lines=AVG (xấp xỉ %/tỷ lệ). Cấp lá: mỗi ô = 1
  // row → dùng luôn value + formattedValue gốc (chính xác tuyệt đối).
  let rows;
  if (!hasGroup) {
    rows = leaf.map((r) => ({
      $tupleId: r.$tupleId, cat: r.cat, group: null, bars: r.bars, lines: r.lines,
    }));
  } else {
    const filtered = leaf.filter((r) => drillPath.every((v, i) => r.levels[i] === v));
    const groupOrder = [];
    const catOrder = [];
    const agg = new Map();
    for (const r of filtered) {
      const gv = r.levels[curLevel] ?? '—';
      if (!groupOrder.includes(gv)) groupOrder.push(gv);
      if (!catOrder.includes(r.cat)) catOrder.push(r.cat);
      const key = `${gv}\u0000${r.cat}`;
      let cell = agg.get(key);
      if (!cell) {
        cell = {
          count: 0, tupleId: null,
          bars: Array.from({ length: nBars }, () => ({ sum: 0, n: 0, f: undefined })),
          lines: Array.from({ length: nLines }, () => ({ sum: 0, n: 0, f: undefined, pct: false })),
        };
        agg.set(key, cell);
      }
      cell.count += 1;
      cell.tupleId = cell.count === 1 ? r.$tupleId : null; // ô 1-row → giữ tuple để select đúng
      r.bars.forEach((b, j) => {
        const c = cell.bars[j];
        if (c && b.v != null) { c.sum += b.v; c.n += 1; c.f = b.f; }
      });
      r.lines.forEach((b, j) => {
        const c = cell.lines[j];
        if (c && b.v != null) {
          c.sum += b.v; c.n += 1; c.f = b.f;
          if (typeof b.f === 'string' && b.f.includes('%')) c.pct = true;
        }
      });
    }
    rows = [];
    for (const gv of groupOrder) {
      for (const cat of catOrder) {
        const cell = agg.get(`${gv}\u0000${cat}`);
        if (!cell) continue;
        const exact = cell.count === 1; // 1 row ⇒ dùng luôn value + format gốc Tableau
        rows.push({
          $tupleId: cell.tupleId,
          cat, group: gv,
          bars: cell.bars.map((c) => (c.n === 0
            ? { v: null, f: undefined }
            : { v: c.sum, f: exact ? c.f : d3.format('~s')(c.sum) })),
          lines: cell.lines.map((c) => (c.n === 0
            ? { v: null, f: undefined }
            : { v: c.sum / c.n, f: exact ? c.f : fmtAggLine(c.sum / c.n, c.pct) })),
        });
      }
    }
  }

  // ---- Bố cục dọc: legend đáy → group label → category label → vùng vẽ ----
  const fontFamily = styles?.['font-family'] || styles?.fontFamily || 'inherit';
  const textColor = styles?.color || '#333';

  const legend = buildLegend(barNames, lineNames, Math.max(0, width - MARGIN.left - MARGIN.right));
  const legendH = legend.rows * 18 + 10;
  const groupLabelH = hasGroup ? 20 : 0;
  const showBreadcrumb = hasGroup && nLevels > 1; // chỉ khi group là hierarchy drill được
  const breadcrumbH = showBreadcrumb ? 20 : 0;

  const innerW = Math.max(0, width - MARGIN.left - MARGIN.right);
  const innerH = Math.max(0, height - MARGIN.top - breadcrumbH - CAT_LABEL_H - groupLabelH - legendH);
  const plotTop = MARGIN.top + breadcrumbH;
  const plotBottom = plotTop + innerH;

  // ---- X: layout thủ công theo "unit" để chèn khoảng trống giữa các group ----
  // Mỗi row chiếm 1 unit; mỗi ranh giới group chèn thêm GAP_UNITS.
  const boundaries = rows.reduce(
    (acc, r, i) => acc + (i > 0 && r.group !== rows[i - 1].group ? 1 : 0),
    0
  );
  const totalUnits = rows.length + boundaries * GAP_UNITS;
  const unit = totalUnits > 0 ? innerW / totalUnits : innerW;

  let cursor = 0;
  const gaps = []; // vị trí x của các vạch đứt giữa group
  rows.forEach((r, i) => {
    if (i > 0 && r.group !== rows[i - 1].group) {
      gaps.push(MARGIN.left + (cursor + GAP_UNITS / 2) * unit);
      cursor += GAP_UNITS;
    }
    r._x0 = MARGIN.left + cursor * unit;      // mép trái slot
    r._center = r._x0 + unit / 2;             // tâm slot (điểm line)
    cursor += 1;
  });
  const catInnerW = unit * (1 - CAT_PAD);
  const clusterX = (r) => r._center - catInnerW / 2;
  const barW = nBars > 0 ? catInnerW / nBars : catInnerW;

  // ---- Y scales (độc lập) ----
  const barValues = rows.flatMap((r) => r.bars.map((b) => b.v)).filter((v) => v != null);
  const lineValues = rows.flatMap((r) => r.lines.map((b) => b.v)).filter((v) => v != null);
  const maxBar = d3.max(barValues) ?? 0;
  const minBar = d3.min(barValues) ?? 0;
  const yLeft = d3.scaleLinear()
    .domain([Math.min(0, minBar), Math.max(0, maxBar)]).nice()
    .range([plotBottom, plotTop]);

  const hasLines = lineNames.length > 0 && lineValues.length > 0;
  const maxLine = d3.max(lineValues) ?? 0;
  const minLine = d3.min(lineValues) ?? 0;
  const yRight = d3.scaleLinear()
    .domain([Math.min(0, minLine), Math.max(0, maxLine)]).nice()
    .range([plotBottom, plotTop]);

  // ---- Fog ----
  const fog = makeFog(bgRgb);
  const anySel = selectedMarkIds.size > 0;
  const barFill = (color, tupleId) =>
    anySel && !selectedMarkIds.has(tupleId) ? fog(color) : color;

  // ---- SVG ----
  const svg = d3.create('svg')
    .attr('class', 'tableau-worksheet')
    .attr('width', width).attr('height', height)
    .attr('viewBox', [0, 0, width, height])
    .style('font-family', fontFamily);

  // Trục trái (bars)
  svg.append('g')
    .attr('transform', `translate(${MARGIN.left},0)`)
    .call(d3.axisLeft(yLeft).ticks(5).tickFormat(d3.format('~s')))
    .attr('color', textColor)
    .selectAll('text').attr('class', 'axis-label').attr('fill', textColor);

  // Trục phải (lines) — chỉ khi có lines
  if (hasLines) {
    svg.append('g')
      .attr('transform', `translate(${MARGIN.left + innerW},0)`)
      .call(d3.axisRight(yRight).ticks(5))
      .attr('color', textColor)
      .selectAll('text').attr('class', 'axis-label').attr('fill', textColor);
  }

  // ---- Breadcrumb drill (chỉ khi group là hierarchy nhiều level) ----
  // "Tất cả › <đã drill…>". Bấm 1 crumb → cắt drillPath về đúng level đó.
  if (showBreadcrumb) {
    const crumbs = ['Tất cả', ...drillPath];
    const bg = svg.append('g');
    let bx = MARGIN.left;
    const by = 16;
    crumbs.forEach((label, k) => {
      if (k > 0) {
        bg.append('text').attr('x', bx).attr('y', by)
          .attr('fill', textColor).attr('opacity', 0.45).text('›');
        bx += 12;
      }
      const isLast = k === crumbs.length - 1;
      const t = bg.append('text')
        .attr('class', isLast ? 'crumb crumb-current' : 'crumb')
        .attr('x', bx).attr('y', by)
        .attr('fill', isLast ? textColor : '#2f6f8f')
        .attr('font-weight', isLast ? 'bold' : 'normal')
        .text(label);
      if (!isLast) {
        t.on('click', (event) => {
          event.stopPropagation();          // không để core hiểu là click nền
          drillPath = drillPath.slice(0, k); // k=0 ('Tất cả') → về gốc
          redraw();
        });
      }
      bx += String(label).length * 6.6 + 10;
    });
    if (curLevel < nLevels - 1) {
      bg.append('text').attr('x', bx + 2).attr('y', by)
        .attr('fill', textColor).attr('opacity', 0.4).attr('font-style', 'italic')
        .text('• bấm nhãn nhóm để drill ▸');
    }
  }

  const y0 = yLeft(0);

  // ---- BARS (mỗi bar mang $tupleId của row) ----
  const barData = [];
  rows.forEach((r) => {
    r.bars.forEach((b, j) => {
      if (b.v == null) return;
      barData.push({
        $tupleId: r.$tupleId,
        x: clusterX(r) + j * barW,
        v: b.v, f: b.f, color: BAR_COLORS[j % BAR_COLORS.length],
      });
    });
  });
  svg.append('g').selectAll('rect')
    .data(barData)
    .join('rect')
    .attr('class', 'bar')
    .each(function (d) { this.__data__ = d; }) // chắc chắn __data__ có $tupleId
    .attr('x', (d) => d.x)
    .attr('width', Math.max(0, barW - 1))
    .attr('y', (d) => Math.min(yLeft(d.v), y0))
    .attr('height', (d) => Math.abs(yLeft(d.v) - y0))
    .attr('fill', (d) => barFill(d.color, d.$tupleId));

  // Nhãn giá trị trên đầu cột (formattedValue của Tableau)
  svg.append('g').selectAll('text')
    .data(barData)
    .join('text')
    .attr('class', 'bar-label')
    .attr('x', (d) => d.x + barW / 2)
    .attr('y', (d) => Math.min(yLeft(d.v), y0) - 3)
    .attr('text-anchor', 'middle')
    .attr('fill', textColor)
    .text((d) => d.f ?? d3.format('~s')(d.v));

  // ---- LINES ----
  if (hasLines) {
    const lineGen = d3.line()
      .defined((d) => d.v != null)
      .x((d) => d._center)
      .y((d) => yRight(d.v));

    lineNames.forEach((name, j) => {
      const color = LINE_COLORS[j % LINE_COLORS.length];
      const pts = rows
        .map((r) => ({ _center: r._center, v: r.lines[j]?.v ?? null, f: r.lines[j]?.f, group: r.group, $tupleId: r.$tupleId }))
        .filter((p) => p.v != null);
      if (!pts.length) return;

      // Đường: nối theo thứ tự category, NHƯNG ngắt ở ranh giới group để line
      // không nhảy ngang qua vạch đứt. Vẽ 1 path cho mỗi khối group.
      const segments = hasGroup
        ? Object.values(pts.reduce((acc, p) => {
            (acc[p.group] ??= []).push(p);
            return acc;
          }, {}))
        : [pts];
      segments.forEach((seg) => {
        svg.append('path')
          .datum(seg)
          .attr('class', 'series-line')
          .attr('d', lineGen)
          .attr('stroke', color)
          .attr('stroke-width', 2.5)
          .attr('opacity', anySel ? 0.4 : 1);
      });

      // Điểm: mang $tupleId → click chọn / hover tooltip.
      svg.append('g').selectAll('circle')
        .data(pts)
        .join('circle')
        .attr('class', 'line-point')
        .each(function (d) { this.__data__ = d; })
        .attr('cx', (d) => d._center)
        .attr('cy', (d) => yRight(d.v))
        .attr('r', 3.5)
        .attr('fill', (d) => barFill(color, d.$tupleId));

      // Nhãn % trong ô bo góc (như hình)
      const labelG = svg.append('g');
      pts.forEach((d) => {
        const label = d.f ?? String(d.v);
        const cx = d._center;
        const cy = yRight(d.v) - 12;
        const w = label.length * 6.2 + 8;
        const gEl = labelG.append('g');
        gEl.append('rect')
          .attr('class', 'line-label-bg')
          .attr('x', cx - w / 2).attr('y', cy - 10)
          .attr('width', w).attr('height', 15).attr('rx', 3)
          .attr('fill', color).attr('opacity', anySel ? 0.18 : 0.16);
        gEl.append('text')
          .attr('class', 'line-label')
          .attr('x', cx).attr('y', cy + 1)
          .attr('text-anchor', 'middle')
          .attr('fill', textColor)
          .text(label);
      });
    });
  }

  // ---- Nhãn category (xoay nhẹ) ----
  svg.append('g').selectAll('text')
    .data(rows)
    .join('text')
    .attr('class', 'axis-label')
    .attr('x', (r) => r._center)
    .attr('y', plotBottom + 14)
    .attr('text-anchor', 'end')
    .attr('fill', textColor)
    .attr('transform', (r) => `rotate(-15,${r._center},${plotBottom + 14})`)
    .text((r) => r.cat);

  // ---- Vạch đứt + nhãn group ----
  if (hasGroup) {
    gaps.forEach((gx) => {
      svg.append('line')
        .attr('x1', gx).attr('x2', gx)
        .attr('y1', plotTop).attr('y2', plotBottom)
        .attr('stroke', textColor).attr('stroke-dasharray', '4,4')
        .attr('opacity', 0.5);
    });
    // Nhãn group: đặt ở tâm khoảng x của các category cùng group.
    const groupSpans = {};
    rows.forEach((r) => {
      const s = groupSpans[r.group] ?? { min: Infinity, max: -Infinity, label: r.group };
      s.min = Math.min(s.min, r._x0);
      s.max = Math.max(s.max, r._x0 + unit);
      groupSpans[r.group] = s;
    });
    const gy = plotBottom + CAT_LABEL_H + 4;
    const drillable = curLevel < nLevels - 1; // còn level con bên dưới → cho drill
    Object.values(groupSpans).forEach((s) => {
      const t = svg.append('text')
        .attr('class', drillable ? 'group-label drillable' : 'group-label')
        .attr('x', (s.min + s.max) / 2).attr('y', gy)
        .attr('text-anchor', 'middle')
        .attr('font-weight', 'bold')
        .attr('fill', drillable ? '#1f6f6f' : textColor)
        .text(drillable ? `${s.label} ▸` : s.label);
      if (drillable) {
        t.on('click', (event) => {
          event.stopPropagation();          // đừng để core hiểu là click nền (clear selection)
          drillPath = [...drillPath, s.label];
          redraw();
        });
      }
    });
  }

  // ---- Legend (đáy) ----
  const legendY = height - legendH + 12;
  const legendG = svg.append('g');
  legend.items.forEach((it) => {
    const gx = MARGIN.left + it.x;
    const gy = legendY + it.row * 18;
    if (it.kind === 'bar') {
      legendG.append('rect')
        .attr('x', gx).attr('y', gy - 9).attr('width', 12).attr('height', 12).attr('rx', 2)
        .attr('fill', it.color);
    } else {
      legendG.append('line')
        .attr('x1', gx).attr('x2', gx + 12).attr('y1', gy - 3).attr('y2', gy - 3)
        .attr('stroke', it.color).attr('stroke-width', 3);
    }
    legendG.append('text')
      .attr('class', 'legend-label')
      .attr('x', gx + 16).attr('y', gy)
      .attr('fill', textColor)
      .text(it.name);
  });

  container.appendChild(svg.node());
}

/**
 * Tính bố cục legend: xếp trái→phải, wrap khi vượt bề rộng.
 * @param {string[]} barNames
 * @param {string[]} lineNames
 * @param {number} maxW
 */
function buildLegend(barNames, lineNames, maxW) {
  const entries = [
    ...barNames.map((name, j) => ({ kind: 'bar', name, color: BAR_COLORS[j % BAR_COLORS.length] })),
    ...lineNames.map((name, j) => ({ kind: 'line', name, color: LINE_COLORS[j % LINE_COLORS.length] })),
  ];
  const items = [];
  let x = 0, row = 0;
  const GAP = 22;
  for (const e of entries) {
    const w = 16 + e.name.length * 6.4 + GAP;
    if (x > 0 && x + w > maxW) { x = 0; row += 1; }
    items.push({ ...e, x, row });
    x += w;
  }
  return { items, rows: row + 1 };
}

/**
 * Format nhãn Lines ở CẤP GỘP (giá trị = trung bình các dòng con — xấp xỉ).
 * pct=true khi formattedValue gốc có '%' ⇒ underlying thường là phân số (0.41 ↔ "41%").
 * @param {number} v   giá trị trung bình
 * @param {boolean} pct
 */
function fmtAggLine(v, pct) {
  if (pct) return Math.abs(v) <= 1.5 ? d3.format('.1%')(v) : `${d3.format(',.1f')(v)}%`;
  return d3.format('~s')(v);
}

window.onload = () => initExtension({ render, containerId: 'content' });
