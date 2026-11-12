import * as vscode from 'vscode';
import { PythonParser } from './parser/pythonParser';
import { PreviewPanel } from './previewPanel';

export function activate(ctx: vscode.ExtensionContext) {
  const parser = new PythonParser(vscode.Uri.joinPath(ctx.extensionUri, 'dist').fsPath);
  parser.init().catch((e) => vscode.window.showErrorMessage(`Python Block Preview: failed to load the parser - ${e}`));

  ctx.subscriptions.push(
    vscode.commands.registerCommand('pyBlockPreview.openToSide', () => {
      PreviewPanel.toggle(ctx, parser, vscode.window.activeTextEditor);
    }),
  );
  // No WebviewPanelSerializer on purpose: the preview does not reopen by itself after a reload.
}

export function deactivate() {}
