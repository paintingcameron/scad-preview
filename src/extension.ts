import * as vscode from 'vscode';
import { PreviewPanel, type Services } from './previewPanel';

export function activate(context: vscode.ExtensionContext): void {
  const services: Services = {
    diagnostics: vscode.languages.createDiagnosticCollection('openscad'),
    output: vscode.window.createOutputChannel('SCAD Preview'),
    statusBar: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100),
  };
  services.statusBar.command = 'scadPreview.showOutput';
  context.subscriptions.push(services.diagnostics, services.output, services.statusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand('scadPreview.open', (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target || !target.fsPath.endsWith('.scad')) {
        void vscode.window.showWarningMessage('SCAD Preview: open a .scad file first.');
        return;
      }
      PreviewPanel.show(context, services, target);
    }),
    vscode.commands.registerCommand('scadPreview.showOutput', () => services.output.show(true)),
    vscode.commands.registerCommand('scadPreview.cancelRender', () => PreviewPanel.cancelActive()),
  );
}

export function deactivate(): void {}
