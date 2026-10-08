import * as vscode from 'vscode';
import { PreviewPanel } from './previewPanel';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('scadPreview.open', (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target || !target.fsPath.endsWith('.scad')) {
        void vscode.window.showWarningMessage('SCAD Preview: open a .scad file first.');
        return;
      }
      PreviewPanel.show(context, target);
    }),
  );
}

export function deactivate(): void {}
