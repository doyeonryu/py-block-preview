import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { PythonParser } from '../src/parser/pythonParser';
import type { DefCard, FlowNode, ModuleModel } from '../src/model/ir';

const ROOT = path.join(__dirname, '..', '..');
const fixture = (name: string) => fs.readFileSync(path.join(ROOT, 'test', 'fixtures', name), 'utf8');

const parser = new PythonParser(path.join(ROOT, 'dist'));
const parse = (src: string) => parser.parse(src, 'test.py');

function allDefs(m: ModuleModel): Map<string, DefCard> {
  const out = new Map<string, DefCard>();
  const walk = (ds: DefCard[]) => ds.forEach((d) => { out.set(d.id, d); walk(d.children); });
  walk(m.defs);
  return out;
}

let sample: ModuleModel;
let defs: Map<string, DefCard>;

before(async () => {
  sample = await parse(fixture('sample.py'));
  defs = allDefs(sample);
});

test('collects imports, globals and stats', () => {
  assert.deepEqual(sample.imports.flatMap((i) => i.names), ['json', 'osp', 'dataclass', 'field', 'Optional']);
  assert.deepEqual(sample.globals.map((g) => g.name), ['CONFIG_PATH', 'MAX_RETRY', '_cache']);
  assert.deepEqual(sample.stats, { classes: 2, functions: 4, methods: 4 });
  assert.equal(sample.errors.length, 0);
});

test('builds function signature, docstring and decorators', () => {
  const user = defs.get('User')!;
  assert.equal(user.kind, 'class');
  assert.deepEqual(user.decorators, ['@dataclass']);
  assert.equal(user.doc, '사용자 정보.');
  const find = defs.get('Repository.find')!;
  assert.equal(find.kind, 'method');
  assert.deepEqual(find.params, ['self', 'name: str']);
  assert.equal(find.returnType, 'Optional[User]');
  const fetch = defs.get('fetch')!;
  assert.equal(fetch.isAsync, true);
});

test('resolves calls inside the file, including self.x and simple type inference', () => {
  const targets = (id: string) => Object.fromEntries(defs.get(id)!.calls.map((c) => [c.name, c.target]));
  assert.equal(targets('Repository.find')['self.load'], 'Repository.load');
  const main = targets('main');
  assert.equal(main['load_config'], 'load_config');
  assert.equal(main['Repository'], 'Repository');
  assert.equal(main['repo.find'], 'Repository.find', 'repo = Repository(...) → repo.find');
  assert.equal(main['user.greet'], 'User.greet', 'user = repo.find(...) -> Optional[User] → user.greet');
  assert.equal(main['print'], undefined, 'builtins stay unresolved');
});

test('computes calledBy, including top-level code', () => {
  assert.deepEqual(defs.get('Repository.load')!.calledBy, ['Repository.find']);
  assert.deepEqual(defs.get('main')!.calledBy, ['<module>']);
  assert.deepEqual(defs.get('unused_helper')!.calledBy, []);
});

test('collects returns, raises, locals and global usage', () => {
  const lc = defs.get('load_config')!;
  assert.deepEqual(lc.raises, ['RuntimeError']);
  assert.deepEqual(lc.returns, ['_cache[path]', '_cache']);
  assert.deepEqual(lc.globalsWritten, ['_cache']);
  assert.deepEqual(lc.globalsRead, ['MAX_RETRY']);
  assert.deepEqual(lc.locals.map((v) => v.name), ['attempt', 'f', 'e']);
  // comprehension variables are not reported as locals
  assert.deepEqual(defs.get('unused_helper')!.locals, []);
});

test('collects class attributes from class body and self.x assignments', () => {
  assert.deepEqual(defs.get('Repository')!.attributes.map((a) => a.name), ['path', 'users', '_loaded']);
  assert.deepEqual(defs.get('User')!.attributes.map((a) => a.name), ['name', 'age', 'tags']);
});

test('builds control flow tree', () => {
  const kinds = (f: FlowNode[]): unknown[] => f.map((n) => (n.children ? [n.kind, kinds(n.children)] : n.kind));
  assert.deepEqual(kinds(defs.get('load_config')!.flow), [
    'global',
    ['if', ['return']],
    ['for', [['try', [['with', ['assign']], 'break']], ['except', ['call', 'continue']]]],
    ['else', ['raise']],
    'return',
  ]);
  assert.deepEqual(kinds(defs.get('main')!.flow).at(-1), ['match', [['case', ['call']], ['case', ['call']]]]);
});

test('flow positions match the source, including multi-byte characters', () => {
  const lines = fixture('sample.py').split(/\r?\n/);
  const check = (f: FlowNode[]) => f.forEach((n) => {
    const at = lines[n.span.sl].slice(n.span.sc);
    const head = n.label.replace(/^(for|while|try)-else$/, 'else').slice(0, 3);
    assert.ok(at.startsWith(head), `L${n.span.sl + 1}:${n.span.sc} "${n.label}" vs "${at.slice(0, 20)}"`);
    if (n.children) check(n.children);
  });
  for (const d of defs.values()) check(d.flow);
  check(sample.mainFlow);
});

test('syntax errors stay inside the broken definition', async () => {
  const m = await parse(fixture('broken.py'));
  const d = allDefs(m);
  assert.deepEqual([...d.keys()], ['ok_before', 'typing_now', 'ok_after', 'Half', 'Half.m']);
  assert.equal(d.get('typing_now')!.hasError, true);
  assert.equal(d.get('ok_after')!.hasError, false);
  assert.equal(d.get('ok_after')!.calls[0].target, 'ok_before');
  assert.ok(m.errors.length > 0);
});

test('handles empty and comment-only files', async () => {
  for (const src of ['', '# just a comment\n', '\n\n']) {
    const m = await parse(src);
    assert.equal(m.defs.length, 0);
    assert.equal(m.errors.length, 0);
  }
});

test('duplicate definitions get unique ids', async () => {
  const m = await parse('def f():\n    pass\n\ndef f():\n    pass\n');
  assert.deepEqual(m.defs.map((d) => d.id), ['f', 'f#2']);
});
