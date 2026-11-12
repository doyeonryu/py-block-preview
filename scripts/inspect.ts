// Run the analyzer outside VS Code and print what the preview would show.
// Usage: npm run inspect [-- path/to/file.py] [--json]
import * as fs from 'fs';
import * as path from 'path';
import { PythonParser } from '../src/parser/pythonParser';
import type { DefCard, FlowNode } from '../src/model/ir';

async function main() {
  const args = process.argv.slice(2);
  const root = path.join(__dirname, '..');
  const file = args.find((a) => !a.startsWith('--')) ?? path.join(root, 'test', 'fixtures', 'sample.py');
  const parser = new PythonParser(path.join(root, 'dist'));
  const src = fs.readFileSync(file, 'utf8');

  const t0 = Date.now();
  const model = await parser.parse(src, path.basename(file));
  const t1 = Date.now();
  await parser.parse(src, path.basename(file));
  const t2 = Date.now();

  // 자가 검증: 흐름 노드 위치(줄/열)가 실제 소스 위치와 맞는지 (한글 등 멀티바이트 문자 포함)
  const srcLines = src.split(/\r?\n/);
  let bad = 0;
  const check = (f: FlowNode[]) => f.forEach((n) => {
    const at = srcLines[n.span.sl]?.slice(n.span.sc) ?? '';
    const head = n.label.replace(/^(for-else|while-else|try-else)$/, 'else').slice(0, 3);
    if (!at.startsWith(head)) { bad++; if (bad <= 5) console.log(`  위치 불일치 L${n.span.sl + 1}:${n.span.sc} label="${n.label}" src="${at.slice(0, 20)}"`); }
    if (n.children) check(n.children);
  });
  const checkDefs = (ds: DefCard[]) => ds.forEach((d) => { check(d.flow); checkDefs(d.children); });
  checkDefs(model.defs);
  check(model.mainFlow);
  if (bad) console.log(`!! 위치 불일치 ${bad}건`);

  if (args.includes('--json')) {
    console.log(JSON.stringify(model, null, 2));
    return;
  }

  console.log(`# ${model.fileName}  (${model.lineCount}줄, 첫 파싱 ${t1 - t0}ms / 재파싱 ${t2 - t1}ms)`);
  console.log(`stats: ${JSON.stringify(model.stats)}  errors: ${model.errors.length}`);
  console.log(`imports: ${model.imports.map((i) => i.names.join(',')).join(' | ')}`);
  console.log(`globals: ${model.globals.map((g) => `${g.name}${g.detail ? ': ' + g.detail : ''}`).join(' | ')}`);
  const printDef = (d: DefCard, ind: string) => {
    const sig = d.kind === 'class' ? `class ${d.name}(${d.bases.join(', ')})` : `${d.isAsync ? 'async ' : ''}def ${d.name}(${d.params.join(', ')})${d.returnType ? ' -> ' + d.returnType : ''}`;
    console.log(`${ind}[${d.kind}] ${sig}  L${d.span.sl + 1}-${d.span.el + 1}  id=${d.id}`);
    if (d.decorators.length) console.log(`${ind}   decorators: ${d.decorators.join(' ')}`);
    if (d.doc) console.log(`${ind}   doc: ${d.doc}`);
    if (d.calls.length) console.log(`${ind}   calls: ${d.calls.map((c) => c.name + (c.target ? `→${c.target}` : '') + (c.count > 1 ? `×${c.count}` : '')).join(', ')}`);
    if (d.calledBy.length) console.log(`${ind}   calledBy: ${d.calledBy.join(', ')}`);
    if (d.returns.length) console.log(`${ind}   returns: ${d.returns.join(' | ')}`);
    if (d.raises.length) console.log(`${ind}   raises: ${d.raises.join(', ')}`);
    if (d.locals.length) console.log(`${ind}   locals: ${d.locals.map((v) => v.name).join(', ')}`);
    if (d.globalsRead.length) console.log(`${ind}   globalsRead: ${d.globalsRead.join(', ')}`);
    if (d.globalsWritten.length) console.log(`${ind}   globalsWritten: ${d.globalsWritten.join(', ')}`);
    if (d.attributes.length) console.log(`${ind}   attributes: ${d.attributes.map((a) => a.name + (a.detail ? ': ' + a.detail : '')).join(', ')}`);
    if (d.kind !== 'class' && d.flow.length) printFlow(d.flow, ind + '   | ');
    d.children.forEach((c) => printDef(c, ind + '    '));
  };
  const printFlow = (f: FlowNode[], ind: string) => {
    for (const n of f) {
      console.log(`${ind}${n.kind}: ${n.label}`);
      if (n.children) printFlow(n.children, ind + '  ');
    }
  };
  model.defs.forEach((d) => printDef(d, ''));
  console.log(`main calls: ${model.mainCalls.map((c) => c.name + (c.target ? `→${c.target}` : '')).join(', ')}`);
  printFlow(model.mainFlow, 'main | ');
  if (model.errors.length) console.log('errors:', model.errors.map((e) => `L${e.span.sl + 1} ${e.message}`));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
