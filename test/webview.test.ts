// Runs the bundled webview script in jsdom and checks rendering and interaction in both views.
// (jsdom has no layout engine, so sizes are 0 — tests check structure, ordering and behaviour.)
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { JSDOM } from 'jsdom';
import { PythonParser } from '../src/parser/pythonParser';
import type { DefCard, ModuleModel } from '../src/model/ir';

const ROOT = path.join(__dirname, '..', '..');
const parser = new PythonParser(path.join(ROOT, 'dist'));
const model = (name: string) =>
  parser.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', name), 'utf8'), name);

let w: JSDOM['window'];
const posted: any[] = [];
const errors: unknown[] = [];
let sample: ModuleModel;

const $ = (s: string) => w.document.querySelector<HTMLElement>(s);
const $$ = (s: string) => [...w.document.querySelectorAll<HTMLElement>(s)];
const send = (data: unknown) => w.dispatchEvent(new w.MessageEvent('message', { data }));
const click = (el: Element | null, opts: MouseEventInit = {}) => {
  assert.ok(el, 'element to click exists');
  el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, ...opts }));
};
const def = (id: string): DefCard => {
  const walk = (ds: DefCard[]): DefCard | undefined => {
    for (const d of ds) { if (d.id === id) return d; const c = walk(d.children); if (c) return c; }
    return undefined;
  };
  return walk(sample.defs)!;
};
const left = (id: string) => parseFloat($(`[data-unit="${id}"]`)!.style.left);

before(async () => {
  sample = await model('sample.py');
  const dom = new JSDOM('<!DOCTYPE html><body><div id="app"></div></body>', { runScripts: 'outside-only', pretendToBeVisual: true });
  w = dom.window;
  let saved: unknown;
  Object.assign(w, {
    acquireVsCodeApi: () => ({ postMessage: (m: unknown) => posted.push(m), getState: () => saved, setState: (s: unknown) => { saved = s; } }),
    scrollTo: () => {},
  });
  w.Element.prototype.scrollIntoView = () => {};
  w.addEventListener('error', (e) => errors.push(e.error ?? e.message));
  w.eval(fs.readFileSync(path.join(ROOT, 'dist', 'webview.js'), 'utf8'));
});

test('announces readiness', () => {
  // objects come from the jsdom realm, so compare by value
  assert.equal(JSON.stringify(posted[0]), JSON.stringify({ type: 'ready' }));
});

// ---- canvas view (default) ----

test('canvas: one block stack per definition plus top-level code and globals', () => {
  send({ type: 'update', model: sample, version: 1, uri: 'file:///sample.py' });
  assert.ok($('body.mode-canvas'));
  assert.deepEqual($$('.stk.unit').map((s) => s.dataset.unit), [
    '@globals', '<module>', 'User', 'Repository', 'load_config', 'unused_helper', 'fetch', 'main',
  ]);
  // methods live inside their class block
  assert.deepEqual($$('[data-unit="Repository"] .stk.fn').map((s) => s.dataset.card),
    ['Repository.__init__', 'Repository.load', 'Repository.find']);
});

test('canvas: columns follow the call graph (caller left of callee)', () => {
  assert.ok(left('<module>') < left('main'));
  assert.ok(left('main') < left('load_config'));
  assert.ok(left('main') < left('Repository'));
  assert.equal(left('<module>'), left('unused_helper'), 'uncalled functions sit in the first column');
});

test('canvas: control flow is drawn as C-shaped blocks', () => {
  const heads = (sel: string) => $$(`${sel} > .cb-head`).map((h) => h.className.match(/f-(\w+)/)![1]);
  const lc = '[data-card="load_config"] > .stmts';
  assert.deepEqual(heads(`${lc} > .cb.f-for`), ['for', 'else']);
  assert.deepEqual(heads(`${lc} > .cb.f-for > .cb-arm > .cb.f-try`), ['try', 'except']);
  assert.deepEqual(heads(`${lc} > .cb.f-if`), ['if']);
  assert.ok($(`${lc} > .sb.f-return`));
});

test('canvas: call arrows connect caller and callee', () => {
  const edges = $$('.edge').map((e) => `${e.dataset.from}→${e.dataset.to}`);
  for (const e of ['main→load_config', 'main→Repository', 'Repository.find→Repository.load', '<module>→main']) {
    assert.ok(edges.includes(e), e);
  }
});

test('canvas: cursor highlights the innermost block', () => {
  const ifLine = def('Repository.find').flow[1].children![0].span.sl;
  send({ type: 'cursor', line: ifLine });
  assert.equal($('.active-card')!.dataset.card, 'Repository.find');
  assert.match($('.cb-head.active')!.textContent!, /u\.name == name/);
});

test('canvas: clicking a hat selects the definition and reveals it in the editor', () => {
  posted.length = 0;
  click($('[data-card="load_config"] > .hat'));
  assert.equal(posted.at(-1).type, 'reveal');
  assert.equal(posted.at(-1).span.sl, def('load_config').span.sl);
  assert.ok($('[data-card="load_config"]')!.classList.contains('selected'));
  assert.match($('#inspector')!.textContent!, /RuntimeError/);
  assert.ok($('.edge.hl[data-from="main"][data-to="load_config"]'));
  click($('[data-action="close-inspector"]'));
  assert.equal($('#inspector')!.textContent!.trim(), '');
});

test('canvas: summary mode hides statements but keeps call links', () => {
  click($('[data-action="detail"][data-value="summary"]'));
  assert.ok($('#world')!.classList.contains('summary'));
  assert.ok($('[data-card="main"] > .sum .chip.link[data-target="load_config"]'));
  const ifLine = def('Repository.find').flow[1].children![0].span.sl;
  send({ type: 'cursor', line: ifLine });
  assert.equal($('.cb-head.active'), null, 'hidden statements are not highlighted');
  assert.equal($('.active-card')!.dataset.card, 'Repository.find');
  click($('[data-action="detail"][data-value="blocks"]'));
});

test('canvas: filter dims non-matching blocks instead of moving them', () => {
  const input = () => $('#filter') as HTMLInputElement;
  input().value = 'load';
  input().dispatchEvent(new w.Event('input', { bubbles: true }));
  assert.ok($('[data-unit="main"]')!.classList.contains('dim'));
  assert.ok(!$('[data-unit="load_config"]')!.classList.contains('dim'));
  input().value = '';
  input().dispatchEvent(new w.Event('input', { bubbles: true }));
  assert.equal($$('.stk.dim').length, 0);
});

// ---- list view ----

test('list: switching modes renders one card per definition', () => {
  click($('[data-action="mode"][data-value="list"]'));
  assert.ok($('body.mode-list'));
  assert.deepEqual($$('.card').map((c) => c.dataset.card), [
    'User', 'User.greet', 'Repository', 'Repository.__init__', 'Repository.load', 'Repository.find',
    'load_config', 'unused_helper', 'fetch', 'main',
  ]);
  assert.match($('header .title')!.textContent!, /클래스 2 · 함수 4 · 메서드 4/);
});

test('list: flags functions that nothing in the file calls', () => {
  const flagged = $$('.badge.warn').map((b) => b.closest<HTMLElement>('.card')!.dataset.card);
  assert.deepEqual(flagged, ['unused_helper', 'fetch']);
});

test('list: cursor highlights the innermost card and flow node', () => {
  const ifLine = def('Repository.find').flow[1].children![0].span.sl;
  click($('[data-toggle-flow="Repository.find"]'));
  send({ type: 'cursor', line: ifLine });
  assert.equal($('.active-card')!.dataset.card, 'Repository.find');
  assert.match($('.f.active > .f-label')!.textContent!, /u\.name == name/);
});

test('list: internal call chips jump between cards without moving the editor', () => {
  posted.length = 0;
  click($('[data-card="main"] .chip.link[data-target="load_config"]'));
  assert.equal(posted.length, 0);
  assert.ok($('#card-load_config')!.classList.contains('flash'));
});

test('list: jumping into a collapsed class expands it', () => {
  click($('[data-toggle-card="Repository"]'));
  assert.equal($('[data-card="Repository.find"]'), null);
  click($('[data-card="main"] .chip.link[data-target="Repository.find"]'));
  assert.ok($('[data-card="Repository.find"]'));
});

test('list: filter hides non-matching cards', () => {
  const input = () => $('#filter') as HTMLInputElement;
  input().value = 'load';
  input().dispatchEvent(new w.Event('input', { bubbles: true }));
  assert.deepEqual($$('.card').map((c) => c.dataset.card), ['Repository', 'Repository.load', 'load_config']);
  input().value = '';
  input().dispatchEvent(new w.Event('input', { bubbles: true }));
});

// ---- both ----

test('marks broken definitions and shows the syntax error count', async () => {
  send({ type: 'update', model: await model('broken.py'), version: 2, uri: 'file:///broken.py' });
  const broken = $$('.card').filter((c) => c.querySelector(':scope > .card-head .badge.err')).map((c) => c.dataset.card);
  assert.deepEqual(broken, ['typing_now', 'Half', 'Half.m']);
  assert.match($('header .badge.err')!.textContent!, /2/);
  click($('[data-action="mode"][data-value="canvas"]'));
  assert.deepEqual($$('.stk[data-card] > .hat .bdg.err').map((b) => b.closest<HTMLElement>('.stk')!.dataset.card),
    ['typing_now', 'Half', 'Half.m']);
});

test('escapes code text instead of injecting HTML', async () => {
  const m = await parser.parse('def f():\n    x = "<img src=x onerror=alert(1)>"\n    return x\n', 'xss.py');
  send({ type: 'update', model: m, version: 3, uri: 'file:///xss.py' });
  assert.equal($('img'), null);
  assert.match($('.sb.f-assign')!.textContent!, /<img/);
});

test('shows a message when there is no Python file', () => {
  send({ type: 'empty', message: 'Python 파일을 열어주세요.' });
  assert.equal($('.empty')!.textContent, 'Python 파일을 열어주세요.');
});

test('no runtime errors', () => {
  assert.deepEqual(errors, []);
});
