// @ts-check
/* global d3 */

/**
 * funnel-treemap.js — one BUILD-ZONE viz, THREE chart types selected by the
 * `?type=` query on the extension URL (funnel | treemap | gauge). Same encodings
 * for all three so the .twb can bind them uniformly:
 *   category  discrete-dimension, 0..1  → funnel stage / treemap slice  (ignored by gauge)
 *   value     continuous-measure, 1     → funnel width / treemap area / gauge value
 *   target    continuous-measure, 0..1  → gauge max (defaults sensibly); ignored by funnel/treemap
 *
 * These marks (tapered funnel, treemap rects, radial gauge) do NOT render on the
 * hand-authored extract path natively — hence a D3 viz extension. Palette is the
 * SHB brand (orange #F58220 / indigo #2E3192). Each element carries $tupleId so
 * the core framework wires click→select and hover→native-tooltip for free.
 *
 * render(info): { encodedData, encodingMap, selectedMarkIds, width, height, styles, bgRgb, container }
 */

import { initExtension } from '../../core/extension.js';
import { makeFog } from '../../core/selection.js';

const TYPE = (new URLSearchParams(location.search).get('type') || 'funnel').toLowerCase();

// SHB brand palette.
const ORANGE = '#F58220', INDIGO = '#2E3192';
const CAT = ['#F58220', '#2E3192', '#5C60C9', '#1E9E6A', '#E8A317', '#D64545', '#B85C13', '#8A8DBF'];
// Funnel depth ramp: bright orange (top / widest) → deep indigo (bottom / narrowest).
const DEPTH = ['#F7A24C', '#F58220', '#B85C13', '#5C60C9', '#2E3192'];

const num = (dv) => { const n = Number(dv?.value); return Number.isFinite(n) ? n : null; };

/** @param {any} info */
function render(info) {
  const { container } = info;
  container.innerHTML = '';
  if (TYPE === 'treemap') return renderTreemap(info);
  if (TYPE === 'gauge') return renderGauge(info);
  return renderFunnel(info);
}

function empty(container, msg) {
  const el = document.createElement('div');
  el.className = 'viz-empty';
  el.textContent = msg;
  container.appendChild(el);
}

function catValRows(encodedData) {
  return encodedData
    .map((r) => ({
      $tupleId: r.$tupleId,
      label: r.category?.[0]?.formattedValue ?? '—',
      value: num(r.value?.[0]),
      fmt: r.value?.[0]?.formattedValue,
    }))
    .filter((r) => r.value != null);
}

function svgRoot(info) {
  const { width, height, styles } = info;
  const fontFamily = styles?.['font-family'] || styles?.fontFamily || 'inherit';
  return d3.create('svg')
    .attr('class', 'tableau-worksheet')
    .attr('width', width).attr('height', height)
    .attr('viewBox', [0, 0, width, height])
    .style('font-family', fontFamily);
}

// ───────────────────────────── FUNNEL ─────────────────────────────
function renderFunnel(info) {
  const { encodedData, selectedMarkIds, width, height, bgRgb, container } = info;
  const rows = catValRows(encodedData).sort((a, b) => b.value - a.value); // widest → narrowest
  if (!rows.length) return empty(container, 'Drop a stage dimension on "Category" and a count/amount measure on "Value".');

  const M = { top: 14, right: 132, bottom: 12, left: 20 };
  const innerW = Math.max(40, width - M.left - M.right);
  const innerH = Math.max(40, height - M.top - M.bottom);
  const cx = M.left + innerW / 2;
  const maxV = d3.max(rows, (r) => r.value) || 1;
  // Floor+cap the width (like ECharts minSize): the top stage is framed with a
  // small side margin instead of spanning edge-to-edge — fixes the "empty Lead"
  // wedges — and the taper stays gentle & balanced.
  const WMIN = 0.34, WMAX = 0.92;
  const W = (v) => (WMIN + (WMAX - WMIN) * (v / maxV)) * innerW;
  const gap = Math.min(6, innerH / rows.length * 0.09);
  const bh = (innerH - gap * (rows.length - 1)) / rows.length;

  const fog = makeFog(bgRgb);
  const anySel = selectedMarkIds.size > 0;
  const svg = svgRoot(info);

  rows.forEach((r, i) => {
    const yTop = M.top + i * (bh + gap);
    const yBot = yTop + bh;
    const topW = W(r.value);
    const botW = W(rows[i + 1] ? rows[i + 1].value : r.value * 0.9); // taper toward next stage
    const color = DEPTH[i % DEPTH.length];
    const fill = anySel && !selectedMarkIds.has(r.$tupleId) ? fog(color) : color;
    const poly = [
      [cx - topW / 2, yTop], [cx + topW / 2, yTop],
      [cx + botW / 2, yBot], [cx - botW / 2, yBot],
    ];
    const seg = svg.append('polygon')
      .attr('class', 'seg')
      .attr('points', poly.map((p) => p.join(',')).join(' '))
      .attr('fill', fill)
      .attr('stroke', '#fff').attr('stroke-width', 2);
    seg.node().__data__ = r;                                // $tupleId for click/hover

    // Inside label: stage name (bold) over the formatted value.
    const g = svg.append('g').attr('class', 'lbl').attr('text-anchor', 'middle');
    g.append('text').attr('x', cx).attr('y', yTop + bh / 2 - 3)
      .attr('fill', '#fff').attr('font-weight', 700).attr('font-size', 13).text(r.label);
    g.append('text').attr('x', cx).attr('y', yTop + bh / 2 + 15)
      .attr('fill', '#ffffffdd').attr('font-size', 12).text(r.fmt ?? d3.format(',')(r.value));

    // Right rail: conversion from the previous (wider) stage.
    if (i > 0) {
      const conv = r.value / rows[i - 1].value;
      svg.append('text').attr('x', width - M.right + 14).attr('y', yTop + bh / 2 + 4)
        .attr('fill', conv >= 0.5 ? '#1E9E6A' : '#B85C13').attr('font-size', 12).attr('font-weight', 700)
        .text('▼ ' + d3.format('.0%')(conv) + ' pass');
    } else {
      svg.append('text').attr('x', width - M.right + 14).attr('y', yTop + bh / 2 + 4)
        .attr('fill', '#94A0B4').attr('font-size', 11).text('entry');
    }
  });
  container.appendChild(svg.node());
}

// ───────────────────────────── TREEMAP ─────────────────────────────
function renderTreemap(info) {
  const { encodedData, selectedMarkIds, width, height, bgRgb, container } = info;
  const rows = catValRows(encodedData).filter((r) => r.value > 0).sort((a, b) => b.value - a.value);
  if (!rows.length) return empty(container, 'Drop a dimension on "Category" and a measure on "Value".');

  // paddingOuter keeps rects off the card's rounded edges (avoids the clipped-label
  // glitch); a small size inset guarantees the bottom row never hugs the card edge.
  const root = d3.hierarchy({ children: rows }).sum((d) => d.value ?? 0);
  d3.treemap().size([width - 2, height - 2]).paddingOuter(2).paddingInner(4).round(true)(root);

  const fog = makeFog(bgRgb);
  const anySel = selectedMarkIds.size > 0;
  const svg = svgRoot(info);

  root.leaves().forEach((leaf, i) => {
    const r = leaf.data;
    const w = leaf.x1 - leaf.x0, h = leaf.y1 - leaf.y0;
    const base = CAT[i % CAT.length];
    const fill = anySel && !selectedMarkIds.has(r.$tupleId) ? fog(base) : base;
    const g = svg.append('g');
    const rect = g.append('rect').attr('class', 'seg')
      .attr('x', leaf.x0).attr('y', leaf.y0).attr('width', w).attr('height', h)
      .attr('rx', 6).attr('fill', fill).attr('stroke', '#fff').attr('stroke-width', 2);
    rect.node().__data__ = r;
    if (w > 46 && h > 22) {
      const tl = g.append('g').attr('class', 'lbl');
      const clamp = (yy) => Math.min(yy, leaf.y1 - 8);      // never spill past the rect
      tl.append('text').attr('x', leaf.x0 + 10).attr('y', clamp(leaf.y0 + 20))
        .attr('fill', '#fff').attr('font-weight', 700).attr('font-size', 14).text(r.label);
      if (h > 44) {
        tl.append('text').attr('x', leaf.x0 + 10).attr('y', clamp(leaf.y0 + 38))
          .attr('fill', '#ffffffe6').attr('font-size', 13).text(r.fmt ?? d3.format(',')(r.value));
      }
    }
  });
  container.appendChild(svg.node());
}

// ───────────────────────────── GAUGE ─────────────────────────────
function renderGauge(info) {
  const { encodedData, width, height, styles, container } = info;
  const v = num(encodedData?.[0]?.value?.[0]);
  if (v == null) return empty(container, 'Drop a measure on "Value" (a ratio like %HT). Optional: a max on "Target".');
  const fmt = encodedData[0]?.value?.[0]?.formattedValue ?? String(v);
  const tgt = num(encodedData[0]?.target?.[0]);
  const max = tgt && tgt > 0 ? tgt : (v > 1.5 ? Math.ceil(v / 20) * 20 : 1.2); // ratio→1.2, count→round up
  const frac = Math.max(0, Math.min(1, v / max));

  const cx = width / 2, cy = height * 0.62, R = Math.min(width * 0.42, height * 0.62);
  const A0 = -Math.PI * 0.75, A1 = Math.PI * 0.75;                    // 270° open-bottom arc
  const arc = d3.arc().innerRadius(R - 12).outerRadius(R).cornerRadius(6);
  const svg = svgRoot(info);
  const g = svg.append('g').attr('transform', `translate(${cx},${cy})`);
  g.append('path').attr('d', arc({ startAngle: A0, endAngle: A1 })).attr('fill', '#EAEEF3');
  const good = v >= (tgt ? tgt : 1) || (max === 1.2 && v >= 1);
  g.append('path').attr('d', arc({ startAngle: A0, endAngle: A0 + (A1 - A0) * frac }))
    .attr('fill', good ? '#1E9E6A' : ORANGE);
  const textColor = styles?.color || '#1F2A44';
  g.append('text').attr('text-anchor', 'middle').attr('y', 6)
    .attr('fill', textColor).attr('font-size', Math.max(20, R * 0.34)).attr('font-weight', 800).text(fmt);
  container.appendChild(svg.node());
}

window.onload = () => initExtension({ render, containerId: 'content' });
