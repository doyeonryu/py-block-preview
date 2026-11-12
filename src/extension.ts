import * as vscode from 'vscode';
import { PythonParser } from './parser/pythonParser';
import { PreviewPanel, PREVIEW_VIEW_TYPE } from './previewPanel';

export function activate(ctx: vscode.ExtensionContext) {
  const parser = new PythonParser(vscode.Uri.joinPath(ctx.extensionUri, 'dist').fsPath);
  parser.init().catch((e) => vscode.window.showErrorMessage(`Python Block Preview: 파서 초기화 실패 - ${e}`));

  ctx.subscriptions.push(
    vscode.commands.registerCommand('pyBlockPreview.openToSide', () => {
      PreviewPanel.createOrShow(ctx, parser, vscode.window.activeTextEditor);
    }),
    vscode.window.registerWebviewPanelSerializer(PREVIEW_VIEW_TYPE, {
      async deserializeWebviewPanel(panel, state: { uri?: string } | undefined) {
        PreviewPanel.revive(panel, ctx, parser, state?.uri);
      },
    }),
  );
}

export function deactivate() {}
