// tree-sitter Python 구문 트리 → ModuleModel (카드 IR) 변환.
// vscode API에 의존하지 않으므로 Node 단독으로 테스트할 수 있다.
import type {
  CallRef, DefCard, FlowKind, FlowNode, ImportRef, ModuleModel, Span, SyntaxErrorRef, VarRef,
} from '../model/ir';
import type { PNode } from './plainTree';

type Node = PNode;

const LABEL_MAX = 90;
const DEF_TYPES = new Set(['function_definition', 'class_definition', 'decorated_definition']);
const IMPORT_TYPES = new Set(['import_statement', 'import_from_statement', 'future_import_statement']);

export function spanOf(n: Node): Span {
  return { sl: n.startPosition.row, sc: n.startPosition.column, el: n.endPosition.row, ec: n.endPosition.column };
}

function oneLine(text: string, max = LABEL_MAX): string {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function field(n: Node, name: string): Node | null {
  return n.childForFieldName(name);
}

/** 중첩 def/class/lambda 안으로는 들어가지 않고 하위 노드를 순회 */
function walkOwn(n: Node, visit: (c: Node) => void, stopAtLambda = false): void {
  for (const c of n.namedChildren) {
    if (DEF_TYPES.has(c.type)) continue;
    if (stopAtLambda && c.type === 'lambda') continue;
    visit(c);
    walkOwn(c, visit, stopAtLambda);
  }
}

/** 중첩 정의까지 포함해 모든 하위 노드 순회 */
function walkOwnDeep(n: Node, visit: (c: Node) => void): void {
  for (const c of n.namedChildren) {
    visit(c);
    walkOwnDeep(c, visit);
  }
}

/** 대입 대상(좌변)에서 단순 이름들을 추출 */
function targetNames(n: Node | null, out: Node[] = []): Node[] {
  if (!n) return out;
  switch (n.type) {
    case 'identifier':
      out.push(n);
      break;
    case 'pattern_list':
    case 'tuple_pattern':
    case 'list_pattern':
    case 'expression_list':
    case 'tuple':
    case 'list':
    case 'list_splat_pattern':
    case 'parenthesized_expression':
      for (const c of n.namedChildren) targetNames(c, out);
      break;
  }
  return out;
}

function docstringOf(body: Node | null): string | undefined {
  const first = body?.namedChildren.find((c) => c.type !== 'comment');
  if (!first || first.type !== 'expression_statement') return undefined;
  const s = first.namedChild(0);
  if (!s || s.type !== 'string') return undefined;
  const raw = s.text.replace(/^[rRbBuUfF]*("""|'''|"|')/, '').replace(/("""|'''|"|')$/, '');
  const line = raw.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  return line ? oneLine(line, 140) : undefined;
}

function isDocstringStmt(n: Node, body: Node): boolean {
  const first = body.namedChildren.find((c) => c.type !== 'comment');
  return first?.id === n.id && n.type === 'expression_statement' && n.namedChild(0)?.type === 'string';
}

// ---------------------------------------------------------------------------

interface Scope {
  card?: DefCard;           // undefined = 모듈 최상위
  classCard?: DefCard;      // 메서드일 때 소속 클래스
  /** 변수 이름 → 같은 파일 안 클래스 카드 (간단한 타입 추론) */
  varTypes?: Map<string, DefCard>;
}

class Analyzer {
  private defs: DefCard[] = [];
  private byName = new Map<string, DefCard[]>(); // 최상위 함수/클래스 이름
  private moduleGlobals = new Set<string>();
  private usedIds = new Set<string>();
  private meta = new Map<string, { node: Node; scope: Scope }>();
  private idMap = new Map<string, DefCard>();
  /** 정의 문장 노드 id → 카드 */
  private byStmt = new Map<number, DefCard>();

  constructor(private root: Node, private fileName: string) {}

  run(): ModuleModel {
    const imports: ImportRef[] = [];
    const globals: VarRef[] = [];
    const topDefs: DefCard[] = [];
    const mainStmts: Node[] = [];

    // 1차: 최상위 문장 분류
    for (const stmt of this.root.namedChildren) {
      if (stmt.type === 'comment') continue;
      if (IMPORT_TYPES.has(stmt.type)) {
        imports.push(this.importOf(stmt));
      } else if (DEF_TYPES.has(stmt.type)) {
        const card = this.buildDef(stmt, '', {});
        if (card) topDefs.push(card);
      } else if (this.isGlobalAssign(stmt)) {
        const a = stmt.namedChild(0)!;
        const detail = field(a, 'type')?.text ?? (field(a, 'right') ? oneLine(field(a, 'right')!.text, 50) : undefined);
        for (const id of targetNames(field(a, 'left'))) {
          globals.push({ name: id.text, span: spanOf(id), detail });
          this.moduleGlobals.add(id.text);
        }
      } else if (isDocstringStmt(stmt, this.root)) {
        continue;
      } else {
        mainStmts.push(stmt);
        // 최상위 for/with 등에서 생긴 이름도 전역
        this.collectAssigned(stmt).forEach((v) => this.moduleGlobals.add(v.name));
      }
    }
    for (const d of topDefs) {
      const list = this.byName.get(d.name) ?? [];
      list.push(d);
      this.byName.set(d.name, list);
    }

    // 2차: 각 카드 본문 분석 (호출, 변수, 흐름)
    for (const d of this.defs) this.fillBody(d);

    // 최상위 코드
    const mainFlow = this.flowOf(mainStmts, 'main');
    const mainCalls = this.callsIn(mainStmts, {});
    // 전역 초기값에서의 호출도 최상위 호출로 취급
    const globalCallNodes = this.root.namedChildren.filter((s) => this.isGlobalAssign(s));
    mergeCalls(mainCalls, this.callsIn(globalCallNodes, {}));

    // 3차: calledBy 역참조
    const byId = this.idMap;
    for (const d of this.defs) {
      for (const c of d.calls) {
        if (c.target && c.target !== d.id) addUnique(byId.get(c.target)?.calledBy, d.id);
      }
    }
    for (const c of mainCalls) if (c.target) addUnique(byId.get(c.target)?.calledBy, '<module>');

    return {
      fileName: this.fileName,
      lineCount: this.root.endPosition.row + 1,
      imports,
      globals,
      defs: topDefs,
      mainFlow,
      mainCalls,
      errors: this.collectErrors(),
      stats: {
        classes: this.defs.filter((d) => d.kind === 'class').length,
        functions: this.defs.filter((d) => d.kind === 'function').length,
        methods: this.defs.filter((d) => d.kind === 'method').length,
      },
    };
  }

  // ---- 분류 헬퍼 ----

  private isGlobalAssign(stmt: Node): boolean {
    if (stmt.type !== 'expression_statement') return false;
    const a = stmt.namedChild(0);
    return !!a && a.type === 'assignment' && targetNames(field(a, 'left')).length > 0
      && field(a, 'left')!.type !== 'attribute' && field(a, 'left')!.type !== 'subscript';
  }

  private importOf(n: Node): ImportRef {
    const names: string[] = [];
    if (n.type === 'import_statement') {
      for (const c of n.namedChildren) names.push((c.type === 'aliased_import' ? field(c, 'alias') : c)?.text ?? c.text);
    } else {
      const mod = field(n, 'module_name');
      for (const c of n.namedChildren) {
        if (c.id === mod?.id) continue;
        if (c.type === 'aliased_import') names.push(field(c, 'alias')?.text ?? c.text);
        else if (c.type === 'dotted_name' || c.type === 'identifier') names.push(c.text);
        else if (c.type === 'wildcard_import') names.push('*');
      }
    }
    return { text: oneLine(n.text, 120), names, span: spanOf(n) };
  }

  // ---- 카드 생성 ----

  private uniqueId(q: string): string {
    let id = q, i = 2;
    while (this.usedIds.has(id)) id = `${q}#${i++}`;
    this.usedIds.add(id);
    return id;
  }

  private buildDef(node: Node, prefix: string, scope: Scope): DefCard | undefined {
    let decorators: string[] = [];
    let def = node;
    if (node.type === 'decorated_definition') {
      decorators = node.namedChildren.filter((c) => c.type === 'decorator').map((c) => oneLine(c.text, 60));
      const inner = field(node, 'definition');
      if (!inner) return undefined;
      def = inner;
    }
    const name = field(def, 'name')?.text ?? '?';
    const qualname = prefix ? `${prefix}.${name}` : name;
    const isClass = def.type === 'class_definition';
    const kind: DefCard['kind'] = isClass ? 'class' : scope.classCard && scope.card === scope.classCard ? 'method' : 'function';

    const card: DefCard = {
      id: this.uniqueId(qualname),
      kind,
      name,
      qualname,
      span: spanOf(node),
      isAsync: !isClass && def.children.some((c) => c.type === 'async'),
      decorators,
      params: [],
      bases: [],
      doc: docstringOf(field(def, 'body')),
      calls: [],
      calledBy: [],
      returns: [],
      raises: [],
      locals: [],
      globalsRead: [],
      globalsWritten: [],
      attributes: [],
      flow: [],
      children: [],
      hasError: def.hasError,
    };
    this.meta.set(card.id, { node: def, scope });
    this.idMap.set(card.id, card);
    this.byStmt.set(node.id, card);

    if (isClass) {
      const sup = field(def, 'superclasses');
      if (sup) card.bases = sup.namedChildren.map((c) => oneLine(c.text, 40));
    } else {
      const params = field(def, 'parameters');
      if (params) card.params = params.namedChildren.filter((c) => c.type !== 'comment').map((c) => oneLine(c.text, 50));
      const rt = field(def, 'return_type');
      if (rt) card.returnType = oneLine(rt.text, 50);
    }

    this.defs.push(card);

    // 중첩 정의 (메서드, 내부 함수, 내부 클래스)
    const body = field(def, 'body');
    if (body) {
      const childScope: Scope = isClass ? { card, classCard: card } : { card, classCard: scope.classCard };
      const visitNested = (n: Node) => {
        for (const c of n.namedChildren) {
          if (DEF_TYPES.has(c.type)) {
            const child = this.buildDef(c, qualname, childScope);
            if (child) card.children.push(child);
          } else if (c.type !== 'lambda') {
            visitNested(c); // if/try 안에 정의된 함수도 찾는다
          }
        }
      };
      visitNested(body);
    }
    return card;
  }

  private fillBody(card: DefCard): void {
    const { node: def, scope } = this.meta.get(card.id)!;
    const body = field(def, 'body');
    if (!body) return;
    const stmts = body.namedChildren.filter((c) => c.type !== 'comment' && !isDocstringStmt(c, body));

    card.flow = this.flowOf(stmts, card.id);
    const classCard = card.kind === 'class' ? card : scope.classCard;
    const varTypes = card.kind === 'class' ? undefined : this.inferVarTypes(card, def, body, classCard);
    card.calls = this.callsIn([body], { card, classCard, varTypes });

    if (card.kind === 'class') {
      // 클래스 변수
      for (const s of stmts) {
        if (s.type === 'expression_statement' && s.namedChild(0)?.type === 'assignment') {
          const a = s.namedChild(0)!;
          for (const id of targetNames(field(a, 'left'))) {
            card.attributes.push({ name: id.text, span: spanOf(id), detail: field(a, 'type')?.text });
          }
        }
      }
      // self.x = ... (모든 메서드에서)
      const seen = new Set(card.attributes.map((a) => a.name));
      for (const m of card.children.filter((c) => c.kind === 'method')) {
        const mNode = this.findDefNode(def, m);
        if (!mNode) continue;
        const selfName = this.firstParamName(mNode) ?? 'self';
        walkOwn(mNode, (n) => {
          if (n.type === 'assignment' || n.type === 'augmented_assignment') {
            const left = field(n, 'left');
            const targets = left?.type === 'attribute' ? [left]
              : (left?.namedChildren ?? []).filter((c) => c.type === 'attribute');
            for (const t of targets) {
              if (field(t, 'object')?.text === selfName) {
                const attr = field(t, 'attribute')!.text;
                if (!seen.has(attr)) {
                  seen.add(attr);
                  card.attributes.push({ name: attr, span: spanOf(t), detail: field(n, 'type')?.text });
                }
              }
            }
          }
        });
      }
      return;
    }

    // 함수/메서드: return / raise / 지역변수 / 전역
    const declaredGlobal = new Set<string>();
    walkOwn(body, (n) => {
      if (n.type === 'return_statement') {
        const v = n.namedChild(0);
        addUnique(card.returns, v ? oneLine(v.text, 40) : 'None');
      } else if (n.type === 'raise_statement') {
        const v = n.namedChild(0);
        const call = v?.type === 'call' ? field(v, 'function') : v;
        addUnique(card.raises, call ? oneLine(call.text, 40) : '(re-raise)');
      } else if (n.type === 'global_statement') {
        n.namedChildren.forEach((c) => declaredGlobal.add(c.text));
      }
    }, true);

    const paramNames = new Set(this.paramNames(def));
    const assigned = this.collectAssigned(body);
    const localSeen = new Set<string>();
    for (const v of assigned) {
      if (declaredGlobal.has(v.name)) {
        addUnique(card.globalsWritten, v.name);
      } else if (!paramNames.has(v.name) && !localSeen.has(v.name)) {
        localSeen.add(v.name);
        card.locals.push(v);
      }
    }
    // 전역 읽기: 지역/매개변수가 아닌 이름 중 모듈 전역과 일치
    walkOwn(body, (n) => {
      if (n.type !== 'identifier') return;
      const p = n.parent;
      if (p?.type === 'attribute' && field(p, 'attribute')?.id === n.id) return;
      if (p?.type === 'keyword_argument' && field(p, 'name')?.id === n.id) return;
      const name = n.text;
      if (this.moduleGlobals.has(name) && !localSeen.has(name) && !paramNames.has(name) && !declaredGlobal.has(name)) {
        addUnique(card.globalsRead, name);
      }
    });
    for (const g of declaredGlobal) if (!card.globalsWritten.includes(g)) addUnique(card.globalsRead, g);
  }

  /** 타입 힌트 문자열에서 같은 파일 클래스 찾기: "Repo", "Optional[Repo]", "Repo | None", "'Repo'" */
  private classFromType(t: string | undefined): DefCard | undefined {
    if (!t) return undefined;
    for (const name of t.match(/[A-Za-z_]\w*/g) ?? []) {
      const c = this.byName.get(name)?.find((d) => d.kind === 'class');
      if (c) return c;
    }
    return undefined;
  }

  /**
   * 가벼운 지역 타입 추론:
   *   x = ClassName(...)      x: ClassName = ...      def f(x: ClassName)
   *   self.attr = ClassName(...) 또는 self.attr: ClassName (메서드 안, "self.attr" 키로 저장)
   */
  private byId(id: string | undefined): DefCard | undefined {
    return id ? this.idMap.get(id) : undefined;
  }

  private inferVarTypes(card: DefCard, def: Node, body: Node, classCard?: DefCard): Map<string, DefCard> {
    const m = new Map<string, DefCard>();
    for (const p of field(def, 'parameters')?.namedChildren ?? []) {
      const name = field(p, 'name')?.text ?? p.namedChildren.find((c) => c.type === 'identifier')?.text;
      const cls = this.classFromType(field(p, 'type')?.text);
      if (name && cls) m.set(name, cls);
    }
    const fromValue = (v: Node | null): DefCard | undefined => {
      if (v?.type === 'await') v = v.namedChild(0);
      if (v?.type !== 'call') return undefined;
      const fn = field(v, 'function');
      if (!fn) return undefined;
      if (fn.type === 'attribute' && field(fn, 'object')?.text === 'cls' && classCard) return classCard;
      // 생성자 호출 또는 반환 타입 힌트가 있는 함수/메서드 호출
      const target = this.byId(this.resolve(fn, { card, classCard, varTypes: m }));
      if (target?.kind === 'class') return target;
      return this.classFromType(target?.returnType);
    };
    const visit = (n: Node) => {
      if (n.type !== 'assignment') return;
      const left = field(n, 'left');
      const cls = this.classFromType(field(n, 'type')?.text) ?? fromValue(field(n, 'right'));
      if (left && cls && (left.type === 'identifier' || left.type === 'attribute')) m.set(left.text, cls);
    };
    walkOwn(body, visit, true);
    // 클래스 전체에서 self.attr 타입 수집 (다른 메서드의 __init__ 등에서 정의된 것)
    if (classCard) {
      for (const [k, v] of this.classAttrTypes(classCard)) if (!m.has(k)) m.set(k, v);
    }
    return m;
  }

  private attrTypeCache = new Map<string, Map<string, DefCard>>();

  private classAttrTypes(cls: DefCard): Map<string, DefCard> {
    let m = this.attrTypeCache.get(cls.id);
    if (m) return m;
    m = new Map();
    this.attrTypeCache.set(cls.id, m);
    const clsNode = this.meta.get(cls.id)?.node;
    if (!clsNode) return m;
    walkOwnDeep(clsNode, (n) => {
      if (n.type !== 'assignment') return;
      const left = field(n, 'left');
      if (left?.type !== 'attribute' || field(left, 'object')?.text !== 'self') return;
      const r = field(n, 'right');
      const fn = r?.type === 'call' ? field(r, 'function') : null;
      const c = this.classFromType(field(n, 'type')?.text)
        ?? (fn?.type === 'identifier' ? this.byName.get(fn.text)?.find((d) => d.kind === 'class') : undefined);
      if (c) m!.set(left.text, c);
    });
    return m;
  }

  private findDefNode(classDef: Node, m: DefCard): Node | undefined {
    const body = field(classDef, 'body');
    for (const c of body?.namedChildren ?? []) {
      const d = c.type === 'decorated_definition' ? field(c, 'definition') : c;
      if (d?.type === 'function_definition' && c.startPosition.row === m.span.sl) return d;
    }
    return undefined;
  }

  private paramNames(def: Node): string[] {
    const out: string[] = [];
    for (const p of field(def, 'parameters')?.namedChildren ?? []) {
      if (p.type === 'identifier') out.push(p.text);
      else {
        const n = field(p, 'name') ?? p.namedChildren.find((c) => c.type === 'identifier')
          ?? p.namedChild(0)?.namedChildren.find((c) => c.type === 'identifier');
        if (n) out.push(n.text);
      }
    }
    return out;
  }

  private firstParamName(def: Node): string | undefined {
    return this.paramNames(def)[0];
  }

  /** 대입/for/with/except 로 이름이 생기는 곳 */
  private collectAssigned(root: Node): VarRef[] {
    const out: VarRef[] = [];
    const add = (target: Node | null, detail?: string) => {
      for (const id of targetNames(target)) out.push({ name: id.text, span: spanOf(id), detail });
    };
    const visit = (n: Node) => {
      switch (n.type) {
        case 'assignment': {
          const t = field(n, 'type')?.text;
          const r = field(n, 'right');
          add(field(n, 'left'), t ?? (r ? oneLine(r.text, 40) : undefined));
          break;
        }
        case 'augmented_assignment':
          add(field(n, 'left'));
          break;
        case 'named_expression':
          add(field(n, 'name'));
          break;
        case 'for_statement':
          add(field(n, 'left'), field(n, 'right') ? `in ${oneLine(field(n, 'right')!.text, 30)}` : undefined);
          break;
        case 'as_pattern': {
          const alias = field(n, 'alias');
          add(alias?.namedChild(0) ?? alias);
          break;
        }
        case 'except_clause':
          add(field(n, 'alias'));
          break;
      }
    };
    visit(root);
    walkOwn(root, visit, true);
    return out;
  }

  // ---- 호출 수집 ----

  private callsIn(roots: Node[], scope: Scope): CallRef[] {
    const out: CallRef[] = [];
    const visit = (n: Node) => {
      if (n.type !== 'call') return;
      const fn = field(n, 'function');
      if (!fn) return;
      const name = fn.type === 'identifier' || fn.type === 'attribute' ? oneLine(fn.text, 50) : oneLine(fn.text, 30);
      mergeCalls(out, [{ name, span: spanOf(n), count: 1, target: this.resolve(fn, scope) }]);
    };
    for (const r of roots) {
      visit(r);
      walkOwn(r, visit);
    }
    return out;
  }

  /** 같은 파일 안의 정의로 해석 */
  private resolve(fn: Node, scope: Scope): string | undefined {
    if (fn.type === 'identifier') {
      // 1) 현재 함수의 내부 함수
      const inner = scope.card?.children.find((c) => c.name === fn.text);
      if (inner) return inner.id;
      // 2) 최상위 함수/클래스
      return this.byName.get(fn.text)?.[0]?.id;
    }
    if (fn.type === 'attribute') {
      const obj = field(fn, 'object');
      const attr = field(fn, 'attribute')?.text;
      if (!obj || !attr) return undefined;
      // repo.find() — repo 의 타입을 추론한 경우
      const typed = scope.varTypes?.get(obj.text);
      if (typed) {
        const m = this.findMethod(typed, attr);
        if (m) return m.id;
      }
      // self.method() / cls.method()
      if (scope.classCard && (obj.text === 'self' || obj.text === 'cls' || obj.text === 'super()')) {
        const m = this.findMethod(scope.classCard, attr);
        if (m) return m.id;
      }
      // ClassName.method()
      const cls = this.byName.get(obj.text)?.find((d) => d.kind === 'class');
      if (cls) return this.findMethod(cls, attr)?.id;
    }
    return undefined;
  }

  private findMethod(cls: DefCard, name: string, depth = 0): DefCard | undefined {
    const m = cls.children.find((c) => c.name === name && c.kind === 'method');
    if (m || depth > 5) return m;
    // 같은 파일 안의 부모 클래스 탐색
    for (const b of cls.bases) {
      const parent = this.byName.get(b)?.find((d) => d.kind === 'class');
      if (parent && parent !== cls) {
        const pm = this.findMethod(parent, name, depth + 1);
        if (pm) return pm;
      }
    }
    return undefined;
  }

  // ---- 실행 흐름 ----

  private flowOf(stmts: Node[], parentId: string): FlowNode[] {
    const out: FlowNode[] = [];
    stmts.forEach((s, i) => {
      if (s.type === 'comment') return;
      out.push(...this.flowNode(s, `${parentId}/${i}`));
    });
    return out;
  }

  private blockFlow(block: Node | null, id: string): FlowNode[] {
    if (!block) return [];
    return this.flowOf(block.namedChildren, id);
  }

  private node(id: string, kind: FlowKind, label: string, n: Node, children?: FlowNode[]): FlowNode {
    return { id, kind, label: oneLine(label), span: spanOf(n), children: children && children.length ? children : undefined };
  }

  private flowNode(s: Node, id: string): FlowNode[] {
    const t = (f: string) => field(s, f)?.text ?? '';
    switch (s.type) {
      case 'if_statement': {
        const res = [this.node(id, 'if', `if ${t('condition')}`, s, this.blockFlow(field(s, 'consequence'), id + 'c'))];
        // if 노드의 범위는 조건~본문까지만
        const cons = field(s, 'consequence');
        if (cons) { res[0].span.el = cons.endPosition.row; res[0].span.ec = cons.endPosition.column; }
        s.namedChildren.forEach((c, k) => {
          if (c.type === 'elif_clause') {
            res.push(this.node(`${id}e${k}`, 'elif', `elif ${field(c, 'condition')?.text ?? ''}`, c, this.blockFlow(field(c, 'consequence'), `${id}e${k}`)));
          } else if (c.type === 'else_clause') {
            res.push(this.node(`${id}x`, 'else', 'else', c, this.blockFlow(field(c, 'body'), `${id}x`)));
          }
        });
        return res;
      }
      case 'for_statement': {
        const kw = s.children.some((c) => c.type === 'async') ? 'async for' : 'for';
        const res = [this.node(id, 'for', `${kw} ${t('left')} in ${t('right')}`, s, this.blockFlow(field(s, 'body'), id))];
        const alt = field(s, 'alternative');
        if (alt) res.push(this.node(id + 'x', 'else', 'for-else', alt, this.blockFlow(field(alt, 'body'), id + 'x')));
        return res;
      }
      case 'while_statement': {
        const res = [this.node(id, 'while', `while ${t('condition')}`, s, this.blockFlow(field(s, 'body'), id))];
        const alt = field(s, 'alternative');
        if (alt) res.push(this.node(id + 'x', 'else', 'while-else', alt, this.blockFlow(field(alt, 'body'), id + 'x')));
        return res;
      }
      case 'try_statement': {
        const res = [this.node(id, 'try', 'try', s, this.blockFlow(field(s, 'body'), id))];
        const b = field(s, 'body');
        if (b) { res[0].span.el = b.endPosition.row; res[0].span.ec = b.endPosition.column; }
        s.namedChildren.forEach((c, k) => {
          const cid = `${id}h${k}`;
          if (c.type === 'except_clause' || c.type === 'except_group_clause') {
            const blk = c.namedChildren.find((x) => x.type === 'block') ?? null;
            const head = c.text.slice(0, blk ? blk.startIndex - c.startIndex : undefined).replace(/:\s*$/, '');
            res.push(this.node(cid, 'except', head, c, this.blockFlow(blk, cid)));
          } else if (c.type === 'else_clause') {
            res.push(this.node(cid, 'else', 'try-else', c, this.blockFlow(field(c, 'body'), cid)));
          } else if (c.type === 'finally_clause') {
            const blk = c.namedChildren.find((x) => x.type === 'block') ?? null;
            res.push(this.node(cid, 'finally', 'finally', c, this.blockFlow(blk, cid)));
          }
        });
        return res;
      }
      case 'with_statement': {
        const clause = s.namedChildren.find((c) => c.type === 'with_clause');
        const kw = s.children.some((c) => c.type === 'async') ? 'async with' : 'with';
        return [this.node(id, 'with', `${kw} ${clause?.text ?? ''}`, s, this.blockFlow(field(s, 'body'), id))];
      }
      case 'match_statement': {
        const cases = (field(s, 'body')?.namedChildren ?? []).filter((c) => c.type === 'case_clause');
        const children = cases.map((c, k) => {
          const pat = c.namedChildren.filter((x) => x.type === 'case_pattern').map((x) => x.text).join(', ');
          const guard = field(c, 'guard');
          return this.node(`${id}k${k}`, 'case', `case ${pat}${guard ? ' ' + guard.text : ''}`, c, this.blockFlow(field(c, 'consequence'), `${id}k${k}`));
        });
        return [this.node(id, 'match', `match ${t('subject')}`, s, children)];
      }
      case 'function_definition':
      case 'class_definition':
      case 'decorated_definition': {
        const d = s.type === 'decorated_definition' ? field(s, 'definition') : s;
        const isClass = d?.type === 'class_definition';
        const name = d ? field(d, 'name')?.text ?? '?' : '?';
        const card = this.byStmt.get(s.id);
        const fl = this.node(id, isClass ? 'class' : 'def', `${isClass ? 'class' : 'def'} ${name}`, s);
        fl.ref = card?.id;
        return [fl];
      }
      case 'return_statement':
        return [this.node(id, 'return', s.text, s)];
      case 'raise_statement':
        return [this.node(id, 'raise', s.text, s)];
      case 'break_statement':
        return [this.node(id, 'break', 'break', s)];
      case 'continue_statement':
        return [this.node(id, 'continue', 'continue', s)];
      case 'pass_statement':
        return [this.node(id, 'pass', 'pass', s)];
      case 'global_statement':
      case 'nonlocal_statement':
        return [this.node(id, 'global', s.text, s)];
      case 'import_statement':
      case 'import_from_statement':
        return [this.node(id, 'import', s.text, s)];
      case 'assert_statement':
        return [this.node(id, 'assert', s.text, s)];
      case 'delete_statement':
        return [this.node(id, 'del', s.text, s)];
      case 'ERROR':
        return [this.node(id, 'error', s.text, s)];
      case 'expression_statement': {
        const e = s.namedChild(0);
        if (!e) return [this.node(id, 'raw', s.text, s)];
        if (e.type === 'assignment' || e.type === 'augmented_assignment') return [this.node(id, 'assign', s.text, s)];
        if (e.type === 'call') return [this.node(id, 'call', s.text, s)];
        if (e.type === 'await') return [this.node(id, 'await', s.text, s)];
        if (e.type === 'yield') return [this.node(id, 'yield', s.text, s)];
        if (e.type === 'string') return []; // 중간에 낀 문자열 주석
        return [this.node(id, 'raw', s.text, s)];
      }
      default:
        return [this.node(id, s.hasError ? 'error' : 'raw', s.text, s)];
    }
  }

  // ---- 구문 오류 ----

  private collectErrors(): SyntaxErrorRef[] {
    const out: SyntaxErrorRef[] = [];
    if (!this.root.hasError) return out;
    const visit = (n: Node) => {
      if (out.length >= 50) return;
      if (n.type === 'ERROR') {
        out.push({ span: spanOf(n), message: `Syntax error: ${oneLine(n.text, 40)}` });
        return;
      }
      if (n.isMissing) {
        out.push({ span: spanOf(n), message: `Missing '${n.type}'` });
        return;
      }
      if (n.hasError) for (const c of n.children) visit(c);
    };
    visit(this.root);
    return out;
  }
}

function addUnique<T>(arr: T[] | undefined, v: T): void {
  if (arr && !arr.includes(v)) arr.push(v);
}

function mergeCalls(into: CallRef[], from: CallRef[]): void {
  for (const c of from) {
    const ex = into.find((x) => x.name === c.name);
    if (ex) {
      ex.count += c.count;
      ex.target ??= c.target;
    } else {
      into.push({ ...c });
    }
  }
}

export function analyze(root: PNode, fileName: string): ModuleModel {
  return new Analyzer(root, fileName).run();
}
