// @ts-check
/* global d3 */

/**
 * barchart.js — VIZ MẪU. Đây là "BUILD ZONE": để tạo viz mới, copy thư mục này
 * rồi viết lại DUY NHẤT hàm render(info). Không đụng src/core/.
 *
 * render(info) nhận (xem src/core/extension.js để biết đầy đủ):
 *   info.encodedData     Array<{ $tupleId, category?: DataValue[], value?: DataValue[] }>
 *   info.encodingMap     { category?: [...], value?: [...] }
 *   info.selectedMarkIds Set<number>
 *   info.width/height    kích thước container
 *   info.styles          CSS từ workbook (fontFamily, color, ...)
 *   info.bgRgb           nền [r,g,b] cho fog
 *   info.container       #content — render SVG vào đây
 *
 * Framework tự lo click→select và hover→tooltip: chỉ cần .datum() mỗi element
 * mang $tupleId (ở đây dùng key function theo d.$tupleId).
 */

import { initExtension } from '../../core/extension.js';
import { makeFog } from '../../core/selection.js';

const BAR_COLOR = '#4e79a7';
const MARGIN = { top: 16, right: 16, bottom: 48, left: 64 };

/** @param {any} info */
function render(info) {
  const { encodedData, selectedMarkIds, width, height, styles, bgRgb, container } = info;

  container.innerHTML = '';

  // Guard: chưa thả field lên cả hai shelf → hướng dẫn thay vì crash.
  const hasCategory = encodedData.some((r) => r.category?.[0] != null);
  const hasValue = encodedData.some((r) => r.value?.[0]?.value != null);
  if (!encodedData.length || !hasCategory || !hasValue) {
    const msg = document.createElement('div');
    msg.className = 'viz-empty';
    msg.textContent = 'Thả 1 dimension lên shelf "Category" và 1 measure lên shelf "Value".';
    container.appendChild(msg);
    return;
  }

  // Chuẩn hoá thành {label, value, $tupleId}. Guard optional bằng ?..
  const rows = encodedData
    .map((r) => ({
      $tupleId: r.$tupleId,
      label: r.category?.[0]?.formattedValue ?? '—',
      value: Number(r.value?.[0]?.value ?? 0),
    }))
    .filter((r) => Number.isFinite(r.value));

  const innerW = Math.max(0, width - MARGIN.left - MARGIN.right);
  const innerH = Math.max(0, height - MARGIN.top - MARGIN.bottom);

  const x = d3.scaleBand().domain(rows.map((r) => r.label)).range([0, innerW]).padding(0.2);
  const maxV = d3.max(rows, (r) => r.value) ?? 0;
  const y = d3.scaleLinear().domain([Math.min(0, maxV), Math.max(0, maxV)]).nice().range([innerH, 0]);

  const fog = makeFog(bgRgb);
  const anySelected = selectedMarkIds.size > 0;
  const fillFor = (d) =>
    anySelected && !selectedMarkIds.has(d.$tupleId) ? fog(BAR_COLOR) : BAR_COLOR;

  const fontFamily = styles?.['font-family'] || styles?.fontFamily || 'inherit';
  const textColor = styles?.color || '#333';

  const svg = d3
    .create('svg')
    .attr('class', 'tableau-worksheet')
    .attr('width', width)
    .attr('height', height)
    .attr('viewBox', [0, 0, width, height])
    .style('font-family', fontFamily);

  const g = svg.append('g').attr('transform', `translate(${MARGIN.left},${MARGIN.top})`);

  // Trục Y
  g.append('g')
    .call(d3.axisLeft(y).ticks(5))
    .attr('color', textColor)
    .selectAll('text')
    .attr('class', 'axis-label')
    .attr('fill', textColor);

  // Trục X
  g.append('g')
    .attr('transform', `translate(0,${innerH})`)
    .call(d3.axisBottom(x))
    .attr('color', textColor)
    .selectAll('text')
    .attr('class', 'axis-label')
    .attr('fill', textColor)
    .attr('transform', 'rotate(-20)')
    .style('text-anchor', 'end');

  const y0 = y(0);

  // BARS — .datum(d) đảm bảo mỗi rect mang $tupleId cho framework đọc lại.
  g.append('g')
    .selectAll('rect')
    .data(rows, (d) => d.$tupleId)
    .join('rect')
    .attr('class', 'bar')
    .each(function (d) { this.__data__ = d; }) // chắc chắn __data__ có $tupleId
    .attr('x', (d) => x(d.label) ?? 0)
    .attr('width', x.bandwidth())
    .attr('y', (d) => Math.min(y(d.value), y0))
    .attr('height', (d) => Math.abs(y(d.value) - y0))
    .attr('fill', fillFor)
    .attr('stroke', (d) => (selectedMarkIds.has(d.$tupleId) ? '#000' : 'none'))
    .attr('stroke-width', (d) => (selectedMarkIds.has(d.$tupleId) ? 2 : 0));

  // Nhãn giá trị trên đầu cột
  g.append('g')
    .selectAll('text')
    .data(rows, (d) => d.$tupleId)
    .join('text')
    .attr('class', 'bar-label')
    .attr('x', (d) => (x(d.label) ?? 0) + x.bandwidth() / 2)
    .attr('y', (d) => Math.min(y(d.value), y0) - 4)
    .attr('text-anchor', 'middle')
    .attr('fill', textColor)
    .text((d) => (d.value >= 1000 ? d3.format('.2s')(d.value) : String(d.value)));

  container.appendChild(svg.node());
}

window.onload = () => initExtension({ render, containerId: 'content' });
