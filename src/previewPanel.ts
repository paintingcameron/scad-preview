import * as path from 'node:path';
import * as vscode from 'vscode';
import { getOpenscadVersion, resolveOpenscadPath } from './openscad';
import type { FromWebview, ToWebview } from './protocol';

/** One preview panel per .scad file. Reopening a file's preview reveals the existing panel. */
export class PreviewPanel {
  private static readonly panels = new Map<string, PreviewPanel>();

  static show(context: vscode.ExtensionContext, uri: vscode.Uri): void {
    const existing = PreviewPanel.panels.get(uri.toString());
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.Beside);
      return;
    }
    PreviewPanel.panels.set(uri.toString(), new PreviewPanel(context, uri));
  }

  private readonly panel: vscode.WebviewPanel;

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly uri: vscode.Uri,
  ) {
    const distUri = vscode.Uri.joinPath(context.extensionUri, 'dist');
    const mediaUri = vscode.Uri.joinPath(context.extensionUri, 'media');
    this.panel = vscode.window.createWebviewPanel(
      'scadPreview',
      `Preview ${path.basename(uri.fsPath)}`,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [distUri, mediaUri],
      },
    );
    this.panel.webview.html = this.html();
    this.panel.onDidDispose(() => PreviewPanel.panels.delete(uri.toString()), null, context.subscriptions);
    this.panel.webview.onDidReceiveMessage((msg: FromWebview) => this.onMessage(msg), null, context.subscriptions);
  }

  private post(msg: ToWebview): void {
    void this.panel.webview.postMessage(msg);
  }

  private async onMessage(msg: FromWebview): Promise<void> {
    if (msg.type !== 'ready') return;
    this.post({ type: 'file', name: path.basename(this.uri.fsPath) });

    const setting = vscode.workspace.getConfiguration('scadPreview').get<string>('openscadPath', '');
    const searchDirs = [
      path.dirname(this.uri.fsPath),
      ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
    ];
    const exe = resolveOpenscadPath(setting, searchDirs);
    try {
      this.post({ type: 'status', openscadPath: exe, version: await getOpenscadVersion(exe) });
    } catch (err) {
      this.post({ type: 'status', openscadPath: exe, error: String(err) });
    }
  }

  private html(): string {
    const webview = this.panel.webview;
    const ext = this.context.extensionUri;
    const script = webview.asWebviewUri(vscode.Uri.joinPath(ext, 'dist', 'webview.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(ext, 'media', 'webview.css'));
    const nonce = makeNonce();
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} blob: data:`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${style}">
</head>
<body>
  <div id="viewport"></div>
  <div id="statusbar"><span id="file"></span><span id="version">Checking OpenSCAD…</span></div>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
