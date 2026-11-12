// Webview entry: renders the ModuleModel (canvas or list view) and keeps it in sync with the editor.
import type { DefCard, FlowNode, ModuleModel, ToWebview } from '../src/model/ir';
import { applyView, canvasHTML, fitView, inspectorHTML, layoutCanvas, revealElement, View, zoomAt } from './canvas';
import {
  chip, defIndex, detailRows, esc, indexDefs, isUncalled, lines, matchesFilter, renderCalls, row, spanAttrs, stripKeyword,
} from './util';

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): any;
  setState(s: any): void;
};

const vscode = acquireVsCodeApi();
const app = document.getElementById('app')!;

interface State {
  uri?: string;
  mode: 'canvas' | 'list';
  detail: 'blocks' | 'summary';
  view: View;
  selected?: string;
  collapsed: string[];   // list view: collapsed cards
  flowOpen: string[];    // list view: cards with expanded flow
  sections: string[];    // list view: collapsed sections
  filter: string;
}
const state: State = {
  mode: 'canvas', detail: 'blocks', view: { x: 0, y: 0, s: 1 },
  collapsed: [], flowOpen: [], sections: [], filter: '',
  ...(vscode.getState() ?? {}),
};
const collapsed = new Set(state.collapsed);
const flowOpen = new Set(state.flowOpen);
const sectionsClosed = new Set(state.sections);
let model: ModuleModel | undefined;
let cursorLine = -1;
let needFit = false;
/** When a new file opens, choose blocks vs summary from how much the view must shrink */
let autoDetail = false;
const AUTO_SUMMARY_SCALE = 0.35;
let worldSize = { w: 0, h: 0 };

function saveState() {
  vscode.setState({ ...state, collapsed: [...collapsed], flowOpen: [...flowOpen], sections: [...sectionsClosed] } satisfies State);
}

// ---------------------------------------------------------------------------
// Rendering

function render() {
  if (!model) return;
  const m = model;
  indexDefs(m.defs);
  document.body.classList.toggle('mode-canvas', state.mode === 'canvas');
  document.body.classList.toggle('mode-list', state.mode === 'list');
  if (state.selected && !defIndex.has(state.selected)) state.selected = undefined;

  const scrollY = window.scrollY;
  const filterFocused = document.activeElement?.id === 'filter';

  app.innerHTML = headerHTML(m) + (state.mode === 'canvas'
    ? canvasHTML(m, { detail: state.detail, filter: state.filter, selected: state.selected })
    : listHTML(m));

  if (state.mode === 'canvas') {
    worldSize = layoutCanvas(m);
    if (needFit) {
      fitView(state.view, worldSize);
      if (autoDetail && state.detail === 'blocks' && state.view.s < AUTO_SUMMARY_SCALE) {
        // a large file: full blocks would be too small to read, start with the summary
        autoDetail = false;
        state.detail = 'summary';
        render();
        return;
      }
      autoDetail = false;
      needFit = false;
      saveState();
    }
    applyView(state.view);
  } else {
    window.scrollTo(0, scrollY);
  }
  if (filterFocused) {
    const inp = document.getElementById('filter') as HTMLInputElement;
    inp.focus();
    inp.setSelectionRange(inp.value.length, inp.value.length);
  }
  highlightCursor(false);
}

function headerHTML(m: ModuleModel): string {
  const errors = m.errors.length
    ? `<span class="badge err" ${spanAttrs(m.errors[0].span)} data-jump title="${esc(m.errors.map((e) => `L${e.span.sl + 1} ${e.message}`).join('\n'))}">⚠ ${m.errors.length} syntax error${m.errors.length > 1 ? 's' : ''}</span>`
    : '';
  const seg = (val: string, cur: string, action: string, label: string, title: string) =>
    `<button class="seg ${val === cur ? 'on' : ''}" data-action="${action}" data-value="${val}" title="${title}">${label}</button>`;
  const modeTools = state.mode === 'canvas'
    ? `<span class="group">${seg('blocks', state.detail, 'detail', 'Blocks', 'Show every statement block')}${seg('summary', state.detail, 'detail', 'Summary', 'Show only names and call links')}</span>
       <span class="group"><button data-action="zoom-out" title="Zoom out (Ctrl+scroll)">−</button><button data-action="zoom-in" title="Zoom in (Ctrl+scroll)">+</button><button data-action="fit" title="Fit the whole file on screen">Fit</button></span>`
    : `<span class="group"><button data-action="expand-all">Expand flow</button><button data-action="collapse-all">Collapse flow</button></span>`;
  return `<header>
      <div class="title"><span class="file">${esc(m.fileName)}</span>
        <span class="muted">${m.lineCount} lines · ${m.stats.classes} classes · ${m.stats.functions} functions · ${m.stats.methods} methods</span>
        ${errors}
      </div>
      <div class="toolbar">
        <span class="group">${seg('canvas', state.mode, 'mode', 'Canvas', 'Block workspace')}${seg('list', state.mode, 'mode', 'List', 'Card list')}</span>
        <input id="filter" type="search" placeholder="Find by name…" value="${esc(state.filter)}">
        ${modeTools}
      </div>
    </header>`;
}

// ---- list view ----

function listHTML(m: ModuleModel): string {
  const parts: string[] = [];
  if (m.imports.length) {
    const chips = m.imports.map((i) => i.names.map((n) => chip(n, 'import', i.span, '', i.text)).join('')).join('');
    parts.push(section('imports', `Imports <span class="count">${m.imports.length}</span>`, `<div class="chips">${chips}</div>`));
  }
  if (m.globals.length) {
    const body = m.globals.map((g) => `<div class="var" ${spanAttrs(g.span)} data-jump><span class="var-name">${esc(g.name)}</span>${g.detail ? `<span class="var-detail">${esc(g.detail)}</span>` : ''}${usedByBadge(g.name)}</div>`).join('');
    parts.push(section('globals', `Globals <span class="count">${m.globals.length}</span>`, `<div class="vars">${body}</div>`));
  }
  const filter = state.filter.trim().toLowerCase();
  const cards = m.defs.map((d) => renderCard(d, filter)).join('');
  parts.push(`<div class="cards">${cards || (filter ? '<div class="muted pad">No definitions match.</div>' : '')}</div>`);
  if (m.mainFlow.length) {
    parts.push(section('main', 'Top-level code', `${row('Calls →', renderCalls(m.mainCalls))}<div class="flow">${renderFlow(m.mainFlow)}</div>`));
  }
  if (!m.defs.length && !m.mainFlow.length && !m.imports.length && !m.globals.length) {
    parts.push('<div class="empty">This file is empty.</div>');
  }
  return `<div class="list">${parts.join('')}</div>`;
}

function section(id: string, title: string, body: string): string {
  const closed = sectionsClosed.has(id);
  return `<section class="sec ${closed ? 'closed' : ''}" data-section="${id}">
    <div class="sec-head" data-toggle-section="${id}"><span class="twisty">${closed ? '▸' : '▾'}</span>${title}</div>
    <div class="sec-body">${body}</div>
  </section>`;
}

function usedByBadge(name: string): string {
  const users: string[] = [];
  for (const d of defIndex.values()) {
    if (d.globalsWritten.includes(name)) users.push(`${d.qualname} (writes)`);
    else if (d.globalsRead.includes(name)) users.push(d.qualname);
  }
  if (!users.length) return '';
  const writes = users.some((u) => u.endsWith('(writes)'));
  return `<span class="mini ${writes ? 'warn' : ''}" title="${esc(users.join('\n'))}">used by ${users.length} function${users.length > 1 ? 's' : ''}${writes ? ' · written' : ''}</span>`;
}

function renderCard(d: DefCard, filter: string): string {
  if (!matchesFilter(d, filter)) return '';
  const isCollapsed = collapsed.has(d.id);
  const kindLabel = d.kind === 'class' ? 'class' : `${d.isAsync ? 'async ' : ''}${d.kind === 'method' ? 'method' : 'def'}`;
  const sig = d.kind === 'class'
    ? (d.bases.length ? `<span class="sig">(${esc(d.bases.join(', '))})</span>` : '')
    : `<span class="sig">(${esc(d.params.join(', '))})</span>${d.returnType ? `<span class="ret"> → ${esc(d.returnType)}</span>` : ''}`;
  const decorators = d.decorators.length ? `<div class="decorators">${d.decorators.map(esc).join(' ')}</div>` : '';
  const badges = [
    d.hasError ? '<span class="badge err">error</span>' : '',
    isUncalled(d) ? '<span class="badge warn" title="Nothing in this file calls it (it may still be used from elsewhere)">unused</span>' : '',
  ].join('');

  let body = '';
  if (!isCollapsed) {
    const rows: string[] = [];
    if (d.doc) rows.push(`<div class="doc">${esc(d.doc)}</div>`);
    rows.push(detailRows(d));
    if (d.kind !== 'class' && d.flow.length) {
      const open = flowOpen.has(d.id);
      rows.push(`<div class="flow-toggle" data-toggle-flow="${esc(d.id)}"><span class="twisty">${open ? '▾' : '▸'}</span>Control flow <span class="count">${countFlow(d.flow)}</span></div>`);
      if (open) rows.push(`<div class="flow">${renderFlow(d.flow)}</div>`);
    }
    const children = d.children.map((c) => renderCard(c, filter)).join('');
    body = `<div class="card-body">${rows.join('')}${children ? `<div class="children">${children}</div>` : ''}</div>`;
  }

  return `<div class="card k-${d.kind} ${isCollapsed ? 'collapsed' : ''}" id="card-${esc(d.id)}" data-card="${esc(d.id)}" ${spanAttrs(d.span)}>
    <div class="card-head">
      <span class="twisty" data-toggle-card="${esc(d.id)}">${isCollapsed ? '▸' : '▾'}</span>
      <div class="head-main" data-jump ${spanAttrs(d.span)}>
        ${decorators}
        <span class="kind">${kindLabel}</span><span class="name">${esc(d.name)}</span>${sig}
      </div>
      <span class="head-right">${badges}<span class="muted">${lines(d.span)} · ${d.span.el - d.span.sl + 1} lines</span></span>
    </div>
    ${body}
  </div>`;
}

function countFlow(f: FlowNode[]): number {
  return f.reduce((n, x) => n + 1 + (x.children ? countFlow(x.children) : 0), 0);
}

const CONTAINER_KINDS = new Set(['if', 'elif', 'else', 'for', 'while', 'try', 'except', 'finally', 'with', 'match', 'case']);

function renderFlow(nodes: FlowNode[]): string {
  return nodes.map((n) => {
    const kids = n.children ? `<div class="f-children">${renderFlow(n.children)}</div>` : '';
    const ref = n.ref ? `data-target="${esc(n.ref)}"` : '';
    const cls = CONTAINER_KINDS.has(n.kind) ? 'f-container' : 'f-leaf';
    return `<div class="f f-${n.kind} ${cls}" ${spanAttrs(n.span)}>
      <div class="f-label" data-jump ${spanAttrs(n.span)} ${ref}><span class="f-kind">${n.kind}</span>${esc(stripKeyword(n))}</div>
      ${kids}
    </div>`;
  }).join('');
}

// ---------------------------------------------------------------------------
// Cursor sync: highlight the innermost definition and statement under the cursor

let lastActiveCard: string | undefined;

function highlightCursor(scroll: boolean) {
  document.querySelectorAll('.active, .active-card').forEach((e) => e.classList.remove('active', 'active-card'));
  if (cursorLine < 0) return;

  const canvas = state.mode === 'canvas';
  const cardSel = canvas ? '.stk[data-card][data-sl]' : '.card[data-sl]';
  const stmtSel = canvas ? '.sb[data-sl], .cb-head[data-sl]' : '.f[data-sl]';
  const hidden = (el: Element) => canvas && state.detail === 'summary' && !!el.closest('.stmts');

  const smallest = (sel: string) => {
    let best: HTMLElement | undefined, size = Infinity;
    document.querySelectorAll<HTMLElement>(sel).forEach((el) => {
      const sl = Number(el.dataset.sl), elx = Number(el.dataset.el);
      if (cursorLine < sl || cursorLine > elx || hidden(el)) return;
      if (elx - sl <= size) { size = elx - sl; best = el; } // ties → later (inner) element
    });
    return best;
  };
  const card = smallest(cardSel);
  const stmt = smallest(stmtSel);
  card?.classList.add('active-card');
  stmt?.classList.add('active');

  const cardId = card?.dataset.card;
  if (scroll) {
    const target = stmt ?? card?.querySelector<HTMLElement>(':scope > .hat, :scope > .card-head') ?? card;
    if (target) {
      if (canvas) {
        if (revealElement(state.view, target)) { applyView(state.view, true); saveState(); }
      } else if (cardId !== lastActiveCard || !inView(target)) {
        target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
  }
  lastActiveCard = cardId;
}

function inView(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  return r.top >= 0 && r.bottom <= window.innerHeight;
}

/** Bring a definition into view and flash it */
function goToCard(id: string) {
  if (state.mode === 'list') {
    let changed = false;
    for (const d of defIndex.values()) {
      if (id.startsWith(d.id + '.') && collapsed.has(d.id)) { collapsed.delete(d.id); changed = true; }
    }
    const d = defIndex.get(id);
    if (d && state.filter && !matchesFilter(d, state.filter.toLowerCase())) { state.filter = ''; changed = true; }
    if (changed) { saveState(); render(); }
  }
  const el = document.getElementById(id === '<module>' ? (state.mode === 'canvas' ? 'card-<module>' : '') : `card-${id}`)
    ?? (id === '<module>' ? document.querySelector<HTMLElement>('[data-section="main"]') : null);
  if (!el) return;
  if (state.mode === 'canvas') {
    if (defIndex.has(id)) selectCard(id);
    revealElement(state.view, el.querySelector<HTMLElement>(':scope > .hat') ?? el, true);
    applyView(state.view, true);
    saveState();
  } else {
    el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

function selectCard(id: string | undefined) {
  state.selected = id;
  document.querySelectorAll('.stk.selected').forEach((e) => e.classList.remove('selected'));
  if (id) document.getElementById(`card-${id}`)?.classList.add('selected');
  const insp = document.getElementById('inspector');
  if (insp) insp.innerHTML = inspectorHTML(id);
  highlightEdges(id);
  saveState();
}

/** Emphasise call arrows touching a definition, dim the rest */
function highlightEdges(id: string | undefined) {
  const world = document.getElementById('world');
  if (!world) return;
  world.querySelectorAll('.edge.hl').forEach((e) => e.classList.remove('hl'));
  world.querySelectorAll('.rel').forEach((e) => e.classList.remove('rel'));
  world.classList.toggle('focus', !!id);
  if (!id) return;
  document.getElementById(`card-${id}`)?.classList.add('rel');
  world.querySelectorAll<SVGPathElement>('.edge').forEach((p) => {
    const from = p.dataset.from, to = p.dataset.to;
    if (from === id || to === id) {
      p.classList.add('hl');
      document.getElementById(`card-${from === id ? to : from}`)?.classList.add('rel');
    }
  });
}

// ---------------------------------------------------------------------------
// Events

let drag: { x: number; y: number; vx: number; vy: number; moved: boolean } | undefined;
let suppressClick = false;

app.addEventListener('mousedown', (ev) => {
  if (state.mode !== 'canvas' || ev.button !== 0) return;
  if (!(ev.target as HTMLElement).closest('#viewport') || (ev.target as HTMLElement).closest('#inspector')) return;
  drag = { x: ev.clientX, y: ev.clientY, vx: state.view.x, vy: state.view.y, moved: false };
});

window.addEventListener('mousemove', (ev) => {
  if (!drag) return;
  const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
  if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
  drag.moved = true;
  document.body.classList.add('panning');
  state.view.x = drag.vx + dx;
  state.view.y = drag.vy + dy;
  applyView(state.view);
});

window.addEventListener('mouseup', () => {
  if (drag?.moved) { suppressClick = true; saveState(); }
  drag = undefined;
  document.body.classList.remove('panning');
});

app.addEventListener('wheel', (ev) => {
  if (state.mode !== 'canvas' || !(ev.target as HTMLElement).closest('#viewport')) return;
  if ((ev.target as HTMLElement).closest('#inspector')) return;
  ev.preventDefault();
  if (ev.ctrlKey || ev.metaKey) {
    const r = document.getElementById('viewport')!.getBoundingClientRect();
    zoomAt(state.view, Math.exp(-ev.deltaY * 0.0025), ev.clientX - r.left, ev.clientY - r.top);
  } else {
    state.view.x -= ev.shiftKey ? ev.deltaY : ev.deltaX;
    state.view.y -= ev.shiftKey ? 0 : ev.deltaY;
  }
  applyView(state.view);
  saveState();
}, { passive: false });

app.addEventListener('mouseover', (ev) => {
  if (state.mode !== 'canvas' || state.selected) return;
  const card = (ev.target as HTMLElement).closest<HTMLElement>('.stk[data-card]');
  highlightEdges(card && defIndex.has(card.dataset.card!) ? card.dataset.card : undefined);
});

app.addEventListener('click', (ev) => {
  if (suppressClick) { suppressClick = false; return; }
  const t = ev.target as HTMLElement;

  const actionEl = t.closest<HTMLElement>('[data-action]');
  if (actionEl) {
    const v = actionEl.dataset.value;
    const vp = document.getElementById('viewport');
    switch (actionEl.dataset.action) {
      case 'mode': state.mode = v as State['mode']; if (v === 'canvas') needFit = true; break;
      case 'detail': state.detail = v as State['detail']; needFit = true; break;
      case 'zoom-in': case 'zoom-out':
        if (vp) zoomAt(state.view, actionEl.dataset.action === 'zoom-in' ? 1.25 : 0.8, vp.clientWidth / 2, vp.clientHeight / 2);
        applyView(state.view, true); saveState();
        return;
      case 'fit': fitView(state.view, worldSize); applyView(state.view, true); saveState(); return;
      case 'close-inspector': selectCard(undefined); return;
      case 'expand-all': flowOpen.clear(); for (const d of defIndex.values()) if (d.flow.length) flowOpen.add(d.id); break;
      case 'collapse-all': flowOpen.clear(); break;
    }
    saveState(); render();
    return;
  }

  const toggles: [string, Set<string>][] = [['toggleCard', collapsed], ['toggleFlow', flowOpen], ['toggleSection', sectionsClosed]];
  for (const [key, set] of toggles) {
    const el = t.closest<HTMLElement>(`[data-${key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}]`);
    if (el) {
      const id = el.dataset[key]!;
      set.has(id) ? set.delete(id) : set.add(id);
      saveState(); render();
      return;
    }
  }

  // Jump between definitions (Ctrl/Cmd+click goes to the code instead)
  const target = t.closest<HTMLElement>('[data-target]');
  if (target && !(ev.ctrlKey || ev.metaKey)) {
    goToCard(target.dataset.target!);
    return;
  }

  // Canvas: clicking a hat selects the definition (and also moves the editor there)
  const sel = t.closest<HTMLElement>('[data-select]');
  if (sel && state.mode === 'canvas') selectCard(sel.dataset.select);

  const jump = t.closest<HTMLElement>('[data-jump]') ?? (target ? document.getElementById(`card-${target.dataset.target}`) : null);
  if (jump?.dataset.sl) {
    vscode.postMessage({ type: 'reveal', span: { sl: +jump.dataset.sl, sc: +(jump.dataset.sc ?? 0), el: +(jump.dataset.el ?? jump.dataset.sl), ec: 0 } });
  } else if (state.mode === 'canvas' && !t.closest('.stk, #inspector, header')) {
    selectCard(undefined); // click on empty space clears the selection
  }
});

app.addEventListener('input', (ev) => {
  const t = ev.target as HTMLInputElement;
  if (t.id === 'filter') {
    state.filter = t.value;
    saveState();
    render();
  }
});

app.addEventListener('keydown', (ev) => {
  const t = ev.target as HTMLInputElement;
  if (t.id === 'filter' && ev.key === 'Enter') {
    // jump to the first definition whose name matches
    const f = t.value.trim().toLowerCase();
    const hit = [...defIndex.values()].find((d) => d.qualname.toLowerCase().includes(f));
    if (hit) goToCard(hit.id);
  }
});

window.addEventListener('resize', () => {
  if (state.mode === 'canvas') applyView(state.view);
});

window.addEventListener('message', (ev: MessageEvent<ToWebview>) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'update':
      model = msg.model;
      if (state.uri !== msg.uri) {
        state.uri = msg.uri;
        state.selected = undefined;
        needFit = true; // a different file: show all of it
        if (state.mode === 'canvas') { state.detail = 'blocks'; autoDetail = true; }
        window.scrollTo(0, 0);
      }
      render();
      saveState();
      break;
    case 'cursor':
      cursorLine = msg.line;
      highlightCursor(true);
      break;
    case 'empty':
      model = undefined;
      app.innerHTML = `<div class="empty">${esc(msg.message)}</div>`;
      break;
  }
});

if (!state.uri) needFit = true;
vscode.postMessage({ type: 'ready' });
