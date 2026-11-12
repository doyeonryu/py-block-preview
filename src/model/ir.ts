// 확장(Extension Host)과 Webview가 공유하는 중간 표현(IR).
// 줄/열 번호는 모두 0-based.

export interface Span {
  sl: number; // start line
  sc: number; // start col
  el: number; // end line
  ec: number; // end col
}

export type FlowKind =
  | 'if' | 'elif' | 'else'
  | 'for' | 'while'
  | 'try' | 'except' | 'finally'
  | 'with' | 'match' | 'case'
  | 'return' | 'raise' | 'yield'
  | 'assign' | 'call' | 'await'
  | 'break' | 'continue' | 'pass'
  | 'def' | 'class'
  | 'global' | 'import' | 'assert' | 'del'
  | 'raw' | 'error';

/** 함수 본문의 실행 흐름(제어 구조) 노드 */
export interface FlowNode {
  id: string;
  kind: FlowKind;
  label: string;
  span: Span;
  children?: FlowNode[];
  /** kind === 'def' | 'class' 일 때 해당 카드의 id */
  ref?: string;
}

export interface CallRef {
  /** 코드에 쓰인 그대로의 호출 대상 (예: "self.load", "np.array") */
  name: string;
  /** 처음 등장한 위치 */
  span: Span;
  /** 등장 횟수 */
  count: number;
  /** 같은 파일 안의 함수/클래스로 해석되면 그 카드 id */
  target?: string;
}

export interface VarRef {
  name: string;
  span: Span;
  /** 타입 힌트 또는 짧은 값 요약 */
  detail?: string;
}

export interface DefCard {
  id: string;
  kind: 'function' | 'method' | 'class';
  name: string;
  qualname: string;
  span: Span;
  isAsync: boolean;
  decorators: string[];
  /** 함수/메서드: 매개변수 원문 목록 */
  params: string[];
  returnType?: string;
  /** 클래스: 상속 목록 */
  bases: string[];
  doc?: string;
  calls: CallRef[];
  /** 이 카드를 호출하는 카드 id 목록 ('<module>' = 최상위 코드) */
  calledBy: string[];
  returns: string[];
  raises: string[];
  locals: VarRef[];
  /** 읽기만 하는 모듈 전역 변수 */
  globalsRead: string[];
  /** global 선언 후 쓰는 전역 변수 */
  globalsWritten: string[];
  /** 클래스: self.x 로 정의되는 인스턴스 속성 + 클래스 변수 */
  attributes: VarRef[];
  flow: FlowNode[];
  children: DefCard[];
  hasError: boolean;
}

export interface ImportRef {
  text: string;
  names: string[];
  span: Span;
}

export interface SyntaxErrorRef {
  span: Span;
  message: string;
}

export interface ModuleModel {
  fileName: string;
  lineCount: number;
  imports: ImportRef[];
  globals: VarRef[];
  defs: DefCard[];
  /** 함수/클래스/import/전역 할당을 제외한 최상위 코드 (예: if __name__ == "__main__") */
  mainFlow: FlowNode[];
  /** 최상위 코드에서 호출하는 것들 */
  mainCalls: CallRef[];
  errors: SyntaxErrorRef[];
  stats: { classes: number; functions: number; methods: number };
}

// ---- 메시지 프로토콜 ----

export type ToWebview =
  | { type: 'update'; model: ModuleModel; version: number; uri: string }
  | { type: 'cursor'; line: number }
  | { type: 'empty'; message: string };

export type FromWebview =
  | { type: 'ready' }
  | { type: 'reveal'; span: Span };
