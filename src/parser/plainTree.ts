// web-tree-sitter 의 SyntaxNode 는 속성에 접근할 때마다 WASM 경계를 넘기 때문에 느리다.
// TreeCursor 로 한 번만 순회해서 순수 JS 객체 트리로 바꾼 뒤 분석한다.
import type Parser from 'web-tree-sitter';

export interface Point { row: number; column: number }

let nextId = 1;

export class PNode {
  readonly id = nextId++;
  parent: PNode | null = null;
  /** 모든 자식 (익명 토큰 포함) */
  children: PNode[] = [];
  namedChildren: PNode[] = [];
  hasError = false;
  private fields?: Map<string, PNode>;

  constructor(
    readonly type: string,
    readonly isNamed: boolean,
    readonly isMissing: boolean,
    readonly startIndex: number,
    readonly endIndex: number,
    readonly startPosition: Point,
    readonly endPosition: Point,
    private readonly source: string,
  ) {}

  get text(): string {
    return this.source.slice(this.startIndex, this.endIndex);
  }

  childForFieldName(name: string): PNode | null {
    return this.fields?.get(name) ?? null;
  }

  namedChild(i: number): PNode | null {
    return this.namedChildren[i] ?? null;
  }

  /** @internal */
  addChild(c: PNode, field: string | null) {
    c.parent = this;
    this.children.push(c);
    if (c.isNamed) this.namedChildren.push(c);
    // 같은 필드가 여러 번 나오면 첫 번째를 유지 (tree-sitter childForFieldName 과 동일)
    if (field && !(this.fields ??= new Map()).has(field)) this.fields.set(field, c);
  }
}

/**
 * @param source   전체 원본 소스 (text 슬라이스용)
 * @param indexOffset / rowOffset  부분 파싱한 조각을 전체 파일 좌표로 옮길 때 사용
 */
const typeCache: { names: (string | undefined)[]; named: boolean[] } = { names: [], named: [] };
const fieldCache: (string | null | undefined)[] = [];

export function toPlain(tree: Parser.Tree, source: string, indexOffset = 0, rowOffset = 0): PNode {
  const cur = tree.walk();
  const typeOf = (): [string, boolean] => {
    const id = cur.nodeTypeId;
    let name = typeCache.names[id];
    if (name === undefined) {
      name = cur.nodeType;
      typeCache.names[id] = name;
      typeCache.named[id] = cur.nodeIsNamed;
    }
    return [name, typeCache.named[id]];
  };
  const fieldOf = (): string | null => {
    const id = cur.currentFieldId;
    if (!id) return null;
    let f = fieldCache[id];
    if (f === undefined) f = fieldCache[id] = cur.currentFieldName || null;
    return f;
  };
  const make = () => {
    const sp = cur.startPosition, ep = cur.endPosition;
    const [type, named] = typeOf();
    return new PNode(
      type, named, cur.nodeIsMissing,
      cur.startIndex + indexOffset, cur.endIndex + indexOffset,
      { row: sp.row + rowOffset, column: sp.column }, { row: ep.row + rowOffset, column: ep.column },
      source,
    );
  };
  const root = make();
  const stack: PNode[] = [root];
  // 깊이 우선 순회 (재귀 없이)
  if (cur.gotoFirstChild()) {
    for (;;) {
      const node = make();
      stack[stack.length - 1].addChild(node, fieldOf());
      if (cur.gotoFirstChild()) {
        stack.push(node);
        continue;
      }
      finish(node);
      while (!cur.gotoNextSibling()) {
        if (!cur.gotoParent() || stack.length === 1) {
          cur.delete();
          finish(root);
          return root;
        }
        finish(stack.pop()!);
      }
    }
  }
  cur.delete();
  finish(root);
  return root;
}

function finish(n: PNode) {
  n.hasError = n.type === 'ERROR' || n.isMissing || n.children.some((c) => c.hasError);
}

/** 여러 조각의 최상위 문장을 하나의 가상 module 노드로 합친다 */
export function mergeRoots(parts: PNode[], source: string): PNode {
  const lines = source.split('\n');
  const root = new PNode(
    'module', true, false, 0, source.length,
    { row: 0, column: 0 }, { row: lines.length - 1, column: lines[lines.length - 1].length },
    source,
  );
  for (const p of parts) for (const c of p.children) root.addChild(c, null);
  finish(root);
  return root;
}
