import * as path from 'path';
import Parser from 'web-tree-sitter';
import { analyze } from './analyze';
import { mergeRoots, PNode, toPlain } from './plainTree';
import type { ModuleModel } from '../model/ir';

/**
 * tree-sitter 파서를 한 번만 초기화해서 재사용한다.
 * wasmDir: tree-sitter.wasm, tree-sitter-python.wasm 이 있는 폴더 (빌드 시 dist/ 로 복사됨)
 */
export class PythonParser {
  private parser?: Parser;
  private initPromise?: Promise<void>;

  constructor(private wasmDir: string) {}

  init(): Promise<void> {
    this.initPromise ??= (async () => {
      await Parser.init({ locateFile: (f: string) => path.join(this.wasmDir, f) });
      const lang = await Parser.Language.load(path.join(this.wasmDir, 'tree-sitter-python.wasm'));
      const p = new Parser();
      p.setLanguage(lang);
      this.parser = p;
    })();
    return this.initPromise;
  }

  async parse(source: string, fileName: string): Promise<ModuleModel> {
    await this.init();
    return analyze(this.parseTree(source), fileName);
  }

  /** 구문 트리 생성. 오류가 있으면 최상위 def/class 단위로 나눠 다시 파싱해서 오류가 번지지 않게 한다. */
  parseTree(source: string): PNode {
    const p = this.parser!;
    const tree = p.parse(source);
    try {
      if (!tree.rootNode.hasError) return toPlain(tree, source);
    } finally {
      tree.delete();
    }
    const parts: PNode[] = [];
    for (const chunk of splitTopLevel(source)) {
      const t = p.parse(chunk.text);
      try {
        parts.push(toPlain(t, source, chunk.index, chunk.row));
      } finally {
        t.delete();
      }
    }
    return mergeRoots(parts, source);
  }
}

interface Chunk { text: string; index: number; row: number }

const BOUNDARY = /^(?:async\s+def|def|class)\b|^@/;

/** 0열에서 시작하는 def / class / 데코레이터 줄을 경계로 소스를 나눈다 */
export function splitTopLevel(source: string): Chunk[] {
  const chunks: Chunk[] = [];
  let start = 0, startRow = 0, row = 0, idx = 0;
  let prevWasDecorator = false;
  while (idx <= source.length) {
    const nl = source.indexOf('\n', idx);
    const end = nl === -1 ? source.length : nl;
    const line = source.slice(idx, end);
    if (BOUNDARY.test(line)) {
      if (!prevWasDecorator && idx > start) {
        chunks.push({ text: source.slice(start, idx), index: start, row: startRow });
        start = idx;
        startRow = row;
      }
      prevWasDecorator = line.startsWith('@');
    } else if (line.trim() && !line.trimStart().startsWith('#')) {
      prevWasDecorator = false;
    }
    if (nl === -1) break;
    idx = nl + 1;
    row++;
  }
  chunks.push({ text: source.slice(start), index: start, row: startRow });
  return chunks;
}
