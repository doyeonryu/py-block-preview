import * as vscode from 'vscode';
import * as path from 'path';
import { PythonParser } from './parser/pythonParser';
import type { FromWebview, ToWebview } from './model/ir';

const VIEW_TYPE = 'pyBlockPreview';
const DEBOUNCE_MS = 150;

/** 마크다운 미리보기처럼, 활성 Python 에디터를 따라가는 단일 미리보기 패널 */
export class PreviewPanel {
  private static current?: PreviewPanel;

  private doc?: vscode.TextDocument;
  private disposables: vscode.Disposable[] = [];
  private timer?: NodeJS.Timeout;
  private version = 0;
  private ready = false;

  /** Open the preview beside the editor, or close it if it is already showing */
  static toggle(ctx: vscode.ExtensionContext, parser: PythonParser, editor?: vscode.TextEditor) {
    const cur = PreviewPanel.current;
    if (cur) {
      if (cur.panel.visible) {
        cur.panel.dispose();
      } else {
        cur.panel.reveal(undefined, true);
        if (editor?.document.languageId === 'python') cur.setDocument(editor.document);
      }
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      'Blocks',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      PreviewPanel.webviewOptions(ctx),
    );
    PreviewPanel.current = new PreviewPanel(panel, ctx, parser, editor?.document);
  }

  private static webviewOptions(ctx: vscode.ExtensionContext): vscode.WebviewOptions & vscode.WebviewPanelOptions {
    return {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'dist')],
    };
  }

  private constructor(
    private panel: vscode.WebviewPanel,
    private ctx: vscode.ExtensionContext,
    private parser: PythonParser,
    doc?: vscode.TextDocument,
  ) {
    panel.iconPath = new vscode.ThemeIcon('type-hierarchy-sub');
    panel.webview.html = this.html();

    this.disposables.push(
      panel.onDidDispose(() => this.dispose()),
      panel.webview.onDidReceiveMessage((m: FromWebview) => this.onMessage(m)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document === this.doc) this.scheduleUpdate();
      }),
      vscode.window.onDidChangeActiveTextEditor((ed) => {
        if (ed && ed.document.languageId === 'python') this.setDocument(ed.document);
      }),
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (e.textEditor.document === this.doc) this.post({ type: 'cursor', line: e.selections[0].active.line });
      }),
    );

    if (doc && doc.languageId === 'python') this.setDocument(doc);
    else {
      const ed = vscode.window.visibleTextEditors.find((e) => e.document.languageId === 'python');
      if (ed) this.setDocument(ed.document);
    }
  }

  private setDocument(doc: vscode.TextDocument) {
    if (this.doc === doc) return;
    this.doc = doc;
    this.panel.title = `Blocks: ${path.basename(doc.fileName)}`;
    this.update();
  }

  private lastParseMs = 0;

  private scheduleUpdate() {
    clearTimeout(this.timer);
    // 큰 파일은 분석 시간에 비례해 디바운스를 늘려 타이핑이 버벅이지 않게 한다
    const delay = Math.min(800, Math.max(DEBOUNCE_MS, this.lastParseMs * 2));
    this.timer = setTimeout(() => this.update(), delay);
  }

  private async update() {
    if (!this.ready) return; // webview 준비되면 'ready' 메시지에서 다시 호출
    const doc = this.doc;
    if (!doc) {
      this.post({ type: 'empty', message: 'Open a Python file to see its blocks.' });
      return;
    }
    const v = ++this.version;
    try {
      const t0 = Date.now();
      const model = await this.parser.parse(doc.getText(), path.basename(doc.fileName));
      this.lastParseMs = Date.now() - t0;
      if (v !== this.version || doc !== this.doc) return; // 더 최신 요청이 있음
      this.post({ type: 'update', model, version: v, uri: doc.uri.toString() });
      const ed = vscode.window.visibleTextEditors.find((e) => e.document === doc);
      if (ed) this.post({ type: 'cursor', line: ed.selection.active.line });
    } catch (err) {
      this.post({ type: 'empty', message: `Could not analyze this file: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  private async onMessage(m: FromWebview) {
    switch (m.type) {
      case 'ready':
        this.ready = true;
        await this.update();
        break;
      case 'reveal': {
        if (!this.doc) return;
        const range = new vscode.Range(m.span.sl, m.span.sc, m.span.sl, m.span.sc);
        let ed = vscode.window.visibleTextEditors.find((e) => e.document === this.doc);
        const column = ed?.viewColumn ?? vscode.ViewColumn.One;
        ed = await vscode.window.showTextDocument(this.doc, { viewColumn: column, preserveFocus: false, selection: range });
        ed.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        break;
      }
    }
  }

  private post(msg: ToWebview) {
    if (this.ready) this.panel.webview.postMessage(msg);
  }

  private html(): string {
    const w = this.panel.webview;
    const dist = vscode.Uri.joinPath(this.ctx.extensionUri, 'dist');
    const js = w.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js'));
    const css = w.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.css'));
    const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
    return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>Blocks</title>
</head>
<body>
<div id="app"><div class="empty">Loading…</div></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }

  private dispose() {
    PreviewPanel.current = undefined;
    clearTimeout(this.timer);
    this.disposables.forEach((d) => d.dispose());
  }
}
