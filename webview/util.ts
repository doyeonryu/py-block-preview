// Helpers shared by the canvas view and the list view.
import type { CallRef, DefCard, FlowNode, Span, VarRef } from '../src/model/ir';

export const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const spanAttrs = (s: Span) => `data-sl="${s.sl}" data-sc="${s.sc}" data-el="${s.el}"`;
export const lines = (s: Span) => (s.el > s.sl ? `L${s.sl + 1}–${s.el + 1}` : `L${s.sl + 1}`);

export function chip(text: string, cls: string, span?: Span, extra = '', title = ''): string {
  return `<span class="chip ${cls}" ${span ? spanAttrs(span) + ' data-jump' : ''} ${extra} ${title ? `title="${esc(title)}"` : ''}>${esc(text)}</span>`;
}

export function row(label: string, content: string, cls = ''): string {
  return content ? `<div class="row ${cls}"><span class="row-label">${label}</span><span class="row-body">${content}</span></div>` : '';
}

/** id → card, for every definition in the current model (rebuilt on each update) */
export const defIndex = new Map<string, DefCard>();

export function indexDefs(defs: DefCard[]) {
  defIndex.clear();
  const walk = (ds: DefCard[]) => ds.forEach((d) => { defIndex.set(d.id, d); walk(d.children); });
  walk(defs);
}

export function displayName(id: string): string {
  if (id === '<module>') return 'top-level code';
  return defIndex.get(id)?.qualname ?? id;
}

export function varChip(v: VarRef, cls: string): string {
  return chip(v.name, cls, v.span, '', v.detail ?? '');
}

export function renderCalls(calls: CallRef[]): string {
  // calls into this file first, library/builtin calls after
  const sorted = [...calls].sort((a, b) => Number(!!b.target) - Number(!!a.target));
  return sorted.map((c) => {
    const label = c.name + (c.count > 1 ? ` ×${c.count}` : '');
    return c.target
      ? chip(label, 'link', undefined, `data-target="${esc(c.target)}"`, `Go to ${displayName(c.target)}`)
      : chip(label, 'ext', c.span, '', 'External or built-in call — click to go to the call site');
  }).join('');
}

export function matchesFilter(d: DefCard, f: string): boolean {
  return !f || d.qualname.toLowerCase().includes(f) || d.children.some((c) => matchesFilter(c, f));
}

function isEntryPointLike(d: DefCard): boolean {
  return /^__.*__$/.test(d.name) || d.name === 'main' || d.decorators.length > 0 || d.name.startsWith('test');
}

/** A function nothing in this file calls (it may still be used from elsewhere) */
export function isUncalled(d: DefCard): boolean {
  return d.kind !== 'class' && d.calledBy.length === 0 && !isEntryPointLike(d);
}

const KEYWORD: Record<string, RegExp> = {
  if: /^if\s+/, elif: /^elif\s+/, for: /^(async\s+)?for\s+/, while: /^while\s+/, with: /^(async\s+)?with\s+/,
  match: /^match\s+/, case: /^case\s+/, return: /^return\b\s*/, raise: /^raise\b\s*/, except: /^except\b\s*/,
  def: /^def\s+/, class: /^class\s+/, assert: /^assert\s+/, del: /^del\s+/,
};

/** The label without its leading keyword (the keyword is shown separately) */
export function stripKeyword(n: FlowNode): string {
  if (['else', 'try', 'finally', 'break', 'continue', 'pass'].includes(n.kind)) {
    return n.label === n.kind ? '' : n.label;
  }
  const r = KEYWORD[n.kind];
  return r ? n.label.replace(r, '') : n.label;
}

/** Details of one definition: calls, callers, returns, raises, variables */
export function detailRows(d: DefCard): string {
  const rows: string[] = [];
  if (d.kind === 'class') rows.push(row('Attributes', d.attributes.map((a) => varChip(a, 'attr')).join('')));
  rows.push(row('Calls →', renderCalls(d.calls)));
  rows.push(row('Called by ←', d.calledBy.map((id) => chip(displayName(id), 'link', undefined, id === '<module>' ? 'data-target="<module>"' : `data-target="${esc(id)}"`)).join('')));
  if (d.kind !== 'class') {
    rows.push(row('Returns', d.returns.map((r) => chip(r, 'ret')).join('')));
    rows.push(row('Raises', d.raises.map((r) => chip(r, 'raise')).join(''), 'raise-row'));
    rows.push(row('Locals', d.locals.map((v) => varChip(v, 'local')).join('')));
    rows.push(row('Globals', [
      ...d.globalsWritten.map((n) => chip(`${n} ✎`, 'global write', undefined, '', 'Writes this global (global statement)')),
      ...d.globalsRead.filter((n) => !d.globalsWritten.includes(n)).map((n) => chip(n, 'global', undefined, '', 'Reads this global')),
    ].join('')));
  }
  return rows.join('');
}
