// Canvas view: every function is a block stack laid out on a 2D, pannable/zoomable workspace.
// Columns follow the call graph — entry points on the left, the functions they call to the right.
import type { DefCard, FlowNode, ModuleModel } from '../src/model/ir';
import {
  chip, defIndex, detailRows, esc, isUncalled, lines, matchesFilter, renderCalls, spanAttrs, stripKeyword,
} from './util';

export interface View { x: number; y: number; s: number }
export interface CanvasOpts { detail: 'blocks' | 'summary'; filter: string; selected?: string }

const MIN_SCALE = 0.15, MAX_SCALE = 2;
const GAP_X = 70, GAP_Y = 22, PAD = 24;

// ---------------------------------------------------------------------------
// HTML

export function canvasHTML(m: ModuleModel, o: CanvasOpts): string {
  const units: string[] = [];
  if (m.imports.length || m.globals.length) units.push(globalsBlock(m));
  if (m.mainFlow.length) units.push(mainStack(m));
  for (const d of m.defs) units.push(d.kind === 'class' ? classBlock(d, o, true) : fnStack(d, o, true));
  const empty = units.length ? '' : '<div class="empty">This file is empty.</div>';
  return `<div class="viewport" id="viewport">
      <div class="world ${o.detail}" id="world">
        <svg class="edges" id="edges" xmlns="http://www.w3.org/2000/svg"></svg>
        ${units.join('')}
      </div>${empty}
      <div class="zoom-ind" id="zoom-ind"></div>
      <div class="inspector" id="inspector">${inspectorHTML(o.selected)}</div>
    </div>`;
}

export function inspectorHTML(id?: string): string {
  const d = id ? defIndex.get(id) : undefined;
  if (!d) return '';
  const sig = d.kind === 'class' ? (d.bases.length ? `(${d.bases.join(', ')})` : '') : `(${d.params.join(', ')})${d.returnType ? ' → ' + d.returnType : ''}`;
  return `<div class="insp-head">
      <span class="insp-title" data-jump ${spanAttrs(d.span)}><b>${esc(d.qualname)}</b><span class="sig">${esc(sig)}</span></span>
      <span class="muted">${lines(d.span)}</span>
      <button class="insp-close" data-action="close-inspector" title="Close">×</button>
    </div>
    ${d.doc ? `<div class="doc">${esc(d.doc)}</div>` : ''}
    ${detailRows(d)}`;
}

function badges(d: DefCard): string {
  return (d.hasError ? '<span class="bdg err" title="Syntax error">!</span>' : '')
    + (isUncalled(d) ? '<span class="bdg warn" title="Nothing in this file calls it">unused</span>' : '');
}

function dimCls(d: DefCard, o: CanvasOpts): string {
  return o.filter && !matchesFilter(d, o.filter.toLowerCase()) ? ' dim' : '';
}

function fnStack(d: DefCard, o: CanvasOpts, top: boolean): string {
  const kw = `${d.isAsync ? 'async ' : ''}${d.kind === 'method' ? 'method' : 'def'}`;
  const ret = d.returnType ? `<span class="hat-ret">→ ${esc(d.returnType)}</span>` : '';
  const nested = d.children.map((c) => (c.kind === 'class' ? classBlock(c, o, false) : fnStack(c, o, false))).join('');
  return `<div class="stk fn k-${d.kind}${top ? ' unit' : ''}${dimCls(d, o)}${o.selected === d.id ? ' selected' : ''}"
      ${top ? `data-unit="${esc(d.id)}"` : ''} data-card="${esc(d.id)}" id="card-${esc(d.id)}" ${spanAttrs(d.span)}>
    ${d.decorators.length ? `<div class="deco">${d.decorators.map(esc).join(' ')}</div>` : ''}
    <div class="hat" data-select="${esc(d.id)}" data-jump ${spanAttrs(d.span)} title="${esc(d.doc ?? '')}">
      <span class="hat-kw">${kw}</span><span class="hat-name">${esc(d.name)}</span><span class="hat-sig">(${esc(d.params.join(', '))})</span>${ret}${badges(d)}
    </div>
    <div class="stmts">${stmts(d.flow) || '<div class="sb f-pass"><b>pass</b></div>'}</div>
    <div class="sum">${summary(d)}</div>
    ${nested ? `<div class="nested">${nested}</div>` : ''}
  </div>`;
}

function classBlock(d: DefCard, o: CanvasOpts, top: boolean): string {
  const bases = d.bases.length ? `<span class="hat-sig">(${esc(d.bases.join(', '))})</span>` : '';
  const attrs = d.attributes.length
    ? `<div class="cls-attrs">${d.attributes.map((a) => chip(a.name, 'attr', a.span, '', a.detail ?? '')).join('')}</div>` : '';
  const body = d.children.map((c) => (c.kind === 'class' ? classBlock(c, o, false) : fnStack(c, o, false))).join('');
  return `<div class="stk cls${top ? ' unit' : ''}${dimCls(d, o)}${o.selected === d.id ? ' selected' : ''}"
      ${top ? `data-unit="${esc(d.id)}"` : ''} data-card="${esc(d.id)}" id="card-${esc(d.id)}" ${spanAttrs(d.span)}>
    ${d.decorators.length ? `<div class="deco">${d.decorators.map(esc).join(' ')}</div>` : ''}
    <div class="hat cls-hat" data-select="${esc(d.id)}" data-jump ${spanAttrs(d.span)} title="${esc(d.doc ?? '')}">
      <span class="hat-kw">class</span><span class="hat-name">${esc(d.name)}</span>${bases}${badges(d)}
    </div>
    ${attrs}
    ${body ? `<div class="cls-body">${body}</div>` : ''}
    <div class="cls-foot"></div>
  </div>`;
}

function mainStack(m: ModuleModel): string {
  const first = m.mainFlow[0].span, last = m.mainFlow[m.mainFlow.length - 1].span;
  const span = { sl: first.sl, sc: first.sc, el: last.el, ec: last.ec };
  return `<div class="stk fn main unit" data-unit="&lt;module&gt;" data-card="&lt;module&gt;" id="card-&lt;module&gt;" ${spanAttrs(span)}>
    <div class="hat main-hat" data-jump ${spanAttrs(span)}><span class="hat-kw">▶ run</span><span class="hat-name">top-level code</span></div>
    <div class="stmts">${stmts(m.mainFlow)}</div>
    <div class="sum">${renderCalls(m.mainCalls.filter((c) => c.target))}</div>
  </div>`;
}

function globalsBlock(m: ModuleModel): string {
  const imports = m.imports.flatMap((i) => i.names.map((n) => chip(n, 'import', i.span, '', i.text))).join('');
  const globals = m.globals.map((g) => chip(g.name, 'gvar', g.span, '', g.detail ?? '')).join('');
  return `<div class="stk vars unit" data-unit="@globals">
    <div class="hat vars-hat"><span class="hat-kw">module</span><span class="hat-name">imports · globals</span></div>
    ${imports ? `<div class="vars-row"><span class="vars-label">import</span>${imports}</div>` : ''}
    ${globals ? `<div class="vars-row"><span class="vars-label">globals</span>${globals}</div>` : ''}
  </div>`;
}

function summary(d: DefCard): string {
  const internal = renderCalls(d.calls.filter((c) => c.target));
  const ext = d.calls.filter((c) => !c.target).length;
  const parts = [
    internal,
    ext ? `<span class="sum-note">${ext} external call${ext > 1 ? 's' : ''}</span>` : '',
    d.raises.length ? `<span class="sum-note raise">raise ${esc(d.raises.join(', '))}</span>` : '',
    d.globalsWritten.length ? `<span class="sum-note warn">writes ${esc(d.globalsWritten.join(', '))}</span>` : '',
  ].join('');
  return parts || '<span class="sum-note">no calls</span>';
}

// ---- statement blocks ----

const C_BLOCK: Record<string, string[]> = {
  if: ['elif', 'else'], for: ['else'], while: ['else'], try: ['except', 'else', 'finally'],
  with: [], match: [], case: [],
};

const KW_LABEL: Partial<Record<FlowNode['kind'], string>> = {
  if: 'if', elif: 'elif', else: 'else', for: 'for', while: 'while', try: 'try', except: 'except', finally: 'finally',
  with: 'with', match: 'match', case: 'case', return: 'return', raise: 'raise', break: 'break', continue: 'continue',
  pass: 'pass', def: 'def', class: 'class', yield: '', await: '', global: '', import: '', assert: 'assert', del: 'del',
};

function stmts(nodes: FlowNode[]): string {
  const out: string[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const cont = C_BLOCK[n.kind];
    if (!cont) {
      out.push(simpleBlock(n));
      continue;
    }
    const arms = [n];
    while (i + 1 < nodes.length && cont.includes(nodes[i + 1].kind)) arms.push(nodes[++i]);
    out.push(cBlock(arms));
  }
  return out.join('');
}

function blockText(n: FlowNode): string {
  const kw = KW_LABEL[n.kind];
  const rest = stripKeyword(n);
  const label = n.kind === 'else' && n.label !== 'else' ? 'else' : kw;
  return `${label ? `<b>${label}</b> ` : ''}${esc(n.kind === 'else' ? '' : rest)}`;
}

function simpleBlock(n: FlowNode): string {
  const ref = n.ref ? `data-target="${esc(n.ref)}"` : '';
  return `<div class="sb f-${n.kind}" data-jump ${spanAttrs(n.span)} ${ref} title="${esc(n.label)}">${blockText(n)}</div>`;
}

function cBlock(arms: FlowNode[]): string {
  const first = arms[0], last = arms[arms.length - 1];
  const body = arms.map((a) => `
    <div class="cb-head f-${a.kind}" data-jump ${spanAttrs(a.span)} title="${esc(a.label)}">${blockText(a)}</div>
    <div class="cb-arm">${a.children ? stmts(a.children) : '<div class="cb-empty"></div>'}</div>`).join('');
  return `<div class="cb f-${first.kind}" data-sl="${first.span.sl}" data-el="${last.span.el}">${body}<div class="cb-foot"></div></div>`;
}

// ---------------------------------------------------------------------------
// Layout

/** Column index for every top-level unit: shortest call distance from an entry point */
function computeDepth(m: ModuleModel): Map<string, number> {
  const topOf = new Map<string, string>();
  const walk = (top: string, ds: DefCard[]) => ds.forEach((d) => { topOf.set(d.id, top); walk(top, d.children); });
  m.defs.forEach((d) => { topOf.set(d.id, d.id); walk(d.id, d.children); });

  const out = new Map<string, Set<string>>();
  const indeg = new Map<string, number>(m.defs.map((d) => [d.id, 0]));
  const addEdge = (a: string, b: string) => {
    if (a === b) return;
    const s = out.get(a) ?? new Set();
    if (s.has(b)) return;
    s.add(b);
    out.set(a, s);
    indeg.set(b, (indeg.get(b) ?? 0) + 1);
  };
  for (const d of defIndex.values()) {
    for (const c of d.calls) if (c.target && topOf.has(c.target)) addEdge(topOf.get(d.id)!, topOf.get(c.target)!);
  }
  for (const c of m.mainCalls) if (c.target && topOf.has(c.target)) addEdge('<module>', topOf.get(c.target)!);

  const depth = new Map<string, number>([['@globals', 0], ['<module>', 0]]);
  const queue = ['<module>', ...m.defs.filter((d) => !indeg.get(d.id)).map((d) => d.id)];
  for (const id of queue) if (!depth.has(id)) depth.set(id, 0);
  while (queue.length) {
    const id = queue.shift()!;
    for (const nxt of out.get(id) ?? []) {
      if (!depth.has(nxt)) {
        depth.set(nxt, depth.get(id)! + 1);
        queue.push(nxt);
      }
    }
  }
  for (const d of m.defs) if (!depth.has(d.id)) depth.set(d.id, 0); // cycles with no entry
  return depth;
}

/** Position of an element relative to the world, ignoring the zoom transform */
function relPos(el: HTMLElement, world: HTMLElement) {
  let x = 0, y = 0;
  let cur: HTMLElement | null = el;
  while (cur && cur !== world) {
    x += cur.offsetLeft;
    y += cur.offsetTop;
    cur = cur.offsetParent as HTMLElement | null;
  }
  return { x, y, w: el.offsetWidth, h: el.offsetHeight };
}

export function layoutCanvas(m: ModuleModel): { w: number; h: number } {
  const world = document.getElementById('world');
  if (!world) return { w: 0, h: 0 };
  const units = [...world.querySelectorAll<HTMLElement>(':scope > .unit')];
  const depth = computeDepth(m);

  const cols = new Map<number, HTMLElement[]>();
  for (const u of units) {
    const d = depth.get(u.dataset.unit!) ?? 0;
    cols.set(d, [...(cols.get(d) ?? []), u]);
  }

  // Wrap tall columns so the whole workspace stays roughly screen-shaped
  const area = units.reduce((a, u) => a + (u.offsetWidth + GAP_X) * (u.offsetHeight + GAP_Y), 0);
  const maxColH = Math.max(500, Math.sqrt(area) * 0.9);

  let x = PAD, maxY = 0;
  for (const d of [...cols.keys()].sort((a, b) => a - b)) {
    let y = PAD, colW = 0;
    for (const u of cols.get(d)!) {
      if (y > PAD && y + u.offsetHeight > maxColH) {
        x += colW + GAP_X;
        y = PAD;
        colW = 0;
      }
      u.style.left = `${x}px`;
      u.style.top = `${y}px`;
      y += u.offsetHeight + GAP_Y;
      colW = Math.max(colW, u.offsetWidth);
      maxY = Math.max(maxY, y);
    }
    x += colW + GAP_X;
  }
  const size = { w: x - GAP_X + PAD, h: maxY + PAD };
  world.style.width = `${size.w}px`;
  world.style.height = `${size.h}px`;
  drawEdges(m, world, size);
  return size;
}

function drawEdges(m: ModuleModel, world: HTMLElement, size: { w: number; h: number }) {
  const svg = document.getElementById('edges');
  if (!svg) return;
  svg.setAttribute('width', String(size.w));
  svg.setAttribute('height', String(size.h));
  const hatOf = (id: string) => document.getElementById(`card-${id}`)?.querySelector<HTMLElement>(':scope > .hat') ?? null;

  const pairs = new Set<string>();
  const paths: string[] = [];
  const add = (from: string, to: string) => {
    const key = `${from}→${to}`;
    if (from === to || pairs.has(key)) return;
    pairs.add(key);
    const a = hatOf(from), b = hatOf(to);
    if (!a || !b) return;
    const p = relPos(a, world), q = relPos(b, world);
    const x1 = p.x + p.w, y1 = p.y + p.h / 2, x2 = q.x, y2 = q.y + q.h / 2;
    const dx = Math.max(50, Math.abs(x2 - x1) / 2);
    paths.push(`<path class="edge" data-from="${esc(from)}" data-to="${esc(to)}" d="M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}" marker-end="url(#arrow)"/>`);
  };
  for (const d of defIndex.values()) for (const c of d.calls) if (c.target) add(d.id, c.target);
  for (const c of m.mainCalls) if (c.target) add('<module>', c.target);

  svg.innerHTML = `<defs>
      <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M0,0 L10,5 L0,10 z" class="arrow-head"/>
      </marker>
    </defs>${paths.join('')}`;
}

// ---------------------------------------------------------------------------
// View transform

export function applyView(v: View, animate = false) {
  const world = document.getElementById('world');
  if (!world) return;
  world.style.transition = animate ? 'transform 0.25s ease-out' : '';
  world.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.s})`;
  const ind = document.getElementById('zoom-ind');
  if (ind) ind.textContent = `${Math.round(v.s * 100)}%`;
}

export function fitView(v: View, size: { w: number; h: number }) {
  const vp = document.getElementById('viewport');
  if (!vp || !size.w || !vp.clientWidth) return;
  const s = clamp(Math.min(vp.clientWidth / size.w, vp.clientHeight / size.h, 1), MIN_SCALE, MAX_SCALE);
  v.s = s;
  v.x = Math.max(0, (vp.clientWidth - size.w * s) / 2);
  v.y = Math.max(0, (vp.clientHeight - size.h * s) / 2);
}

export function zoomAt(v: View, factor: number, px: number, py: number) {
  const ns = clamp(v.s * factor, MIN_SCALE, MAX_SCALE);
  v.x = px - ((px - v.x) * ns) / v.s;
  v.y = py - ((py - v.y) * ns) / v.s;
  v.s = ns;
}

/** Pan so that the element is visible; returns true when the view moved */
export function revealElement(v: View, el: HTMLElement, center = false): boolean {
  const vp = document.getElementById('viewport');
  const world = document.getElementById('world');
  if (!vp || !world) return false;
  const p = relPos(el, world);
  const left = v.x + p.x * v.s, top = v.y + p.y * v.s;
  const w = Math.min(p.w * v.s, vp.clientWidth), h = Math.min(p.h * v.s, vp.clientHeight);
  const margin = 40;
  const visible = left >= 0 && top >= 0 && left + w <= vp.clientWidth && top + h <= vp.clientHeight;
  if (visible && !center) return false;
  v.x += vp.clientWidth / 2 - (left + w / 2);
  const targetTop = center ? (vp.clientHeight - h) / 2 : Math.min(vp.clientHeight / 3, vp.clientHeight - h - margin);
  v.y += Math.max(margin, targetTop) - top;
  return true;
}

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
