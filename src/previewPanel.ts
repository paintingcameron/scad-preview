import * as path from 'node:path';
import * as vscode from 'vscode';
import { parseEchoes, parseScadMessages, type ScadMessage } from './messages';
import { getOpenscadVersion, resolveOpenscadPath } from './openscad';
import type { FromWebview, ToWebview } from './protocol';
import { RenderQueue, type RenderResult } from './renderer';

/** Shared across all panels; created once in activate(). */
export interface Services {
  diagnostics: vscode.DiagnosticCollection;
  output: vscode.OutputChannel;
  statusBar: vscode.StatusBarItem;
}

/** One preview panel per .scad file. Reopening a file's preview reveals the existing panel. */
export class PreviewPanel {
  private static readonly panels = new Map<string, PreviewPanel>();

  static show(context: vscode.ExtensionContext, services: Services, uri: vscode.Uri): void {
    const existing = PreviewPanel.panels.get(uri.toString());
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.Beside);
      return;
    }
    PreviewPanel.panels.set(uri.toString(), new PreviewPanel(context, services, uri));
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly queue: RenderQueue;
  private readonly disposables: vscode.Disposable[] = [];
  private exe?: string;
  /** Files the last successful render read; saving any of them re-renders. */
  private deps = new Set<string>();
  /** Files this panel has put diagnostics on, so they can be cleared before the next render. */
  private diagnosticFiles: vscode.Uri[] = [];
  private statusText = '';
  private statusTooltip = '';

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly services: Services,
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
    this.queue = new RenderQueue(
      () => this.onRenderStart(),
      (result) => this.onRenderResult(result),
    );

    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((msg: FromWebview) => this.onMessage(msg)),
      this.panel.onDidChangeViewState(() => this.updateStatusBar()),
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (doc.uri.fsPath === this.uri.fsPath || this.deps.has(doc.uri.fsPath)) this.render();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('scadPreview.openscadPath')) void this.resolveAndRender();
        if (e.affectsConfiguration('scadPreview.defaultColor')) this.postSettings();
      }),
    );
    this.panel.onDidDispose(() => this.dispose(), null, context.subscriptions);
  }

  private dispose(): void {
    PreviewPanel.panels.delete(this.uri.toString());
    this.queue.dispose();
    this.clearDiagnostics();
    this.services.statusBar.hide();
    for (const d of this.disposables) d.dispose();
  }

  private post(msg: ToWebview): void {
    void this.panel.webview.postMessage(msg);
  }

  private onMessage(msg: FromWebview): void {
    switch (msg.type) {
      case 'ready':
        this.post({ type: 'file', name: path.basename(this.uri.fsPath) });
        this.postSettings();
        void this.resolveAndRender();
        break;
      case 'rerender':
        this.render(0);
        break;
    }
  }

  private postSettings(): void {
    const config = vscode.workspace.getConfiguration('scadPreview');
    this.post({ type: 'settings', defaultColor: config.get<string>('defaultColor', '#ffffff') });
  }

  private async resolveAndRender(): Promise<void> {
    const setting = vscode.workspace.getConfiguration('scadPreview').get<string>('openscadPath', '');
    const searchDirs = [
      path.dirname(this.uri.fsPath),
      ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
    ];
    const exe = resolveOpenscadPath(setting, searchDirs);
    try {
      this.post({ type: 'status', openscadPath: exe, version: await getOpenscadVersion(exe) });
      this.exe = exe;
      this.render(0);
    } catch (err) {
      this.exe = undefined;
      this.post({ type: 'status', openscadPath: exe, error: String(err) });
      this.setStatus('$(error) OpenSCAD not found', `${exe}\n${String(err)}`);
    }
  }

  private render(delayMs = 300): void {
    if (this.exe) this.queue.request({ exe: this.exe, file: this.uri.fsPath }, delayMs);
  }

  private onRenderStart(): void {
    this.post({ type: 'renderStarted' });
    this.setStatus('$(sync~spin) Rendering…', path.basename(this.uri.fsPath));
  }

  private onRenderResult(result: RenderResult): void {
    const name = path.basename(this.uri.fsPath);
    const messages = parseScadMessages(result.output, this.uri.fsPath);
    const errors = messages.filter((m) => m.severity === 'error').length;
    const warnings = messages.length - errors;
    this.showDiagnostics(messages);
    this.logOutput(result);
    if (result.deps.length > 0) this.deps = new Set(result.deps);

    const seconds = `${(result.ms / 1000).toFixed(2)} s`;
    const problems = errors + warnings > 0 ? ` · ${errors} error(s), ${warnings} warning(s)` : '';
    if (result.ok && result.model) {
      const facets = result.summary?.geometry?.facets;
      this.post({ type: 'renderDone', model: result.model, facets, ms: result.ms, errors, warnings });
      const icon = errors > 0 ? '$(warning)' : warnings > 0 ? '$(warning)' : '$(check)';
      this.setStatus(`${icon} ${facets ?? '?'} facets · ${seconds}`, `${name}${problems}`);
    } else if (result.empty) {
      // An empty model is usually caused by an earlier problem, such as a missing include.
      const first = messages.find((m) => m.severity === 'error') ?? messages[0];
      const firstProblem = first && `${first.message}${first.location ? ` (${path.basename(first.location.file)}:${first.location.line})` : ''}`;
      this.post({ type: 'renderEmpty', ms: result.ms, errors, warnings, firstProblem });
      this.setStatus(`$(circle-slash) Empty model · ${seconds}`, `${name}${problems}`);
    } else {
      const first = messages.find((m) => m.severity === 'error')?.message;
      const message = first ?? lastLine(result.output) ?? `OpenSCAD exited with code ${result.exitCode}`;
      this.post({ type: 'renderFailed', message, ms: result.ms });
      this.setStatus('$(error) Render failed', `${name}: ${message}`);
    }
  }

  private showDiagnostics(messages: ScadMessage[]): void {
    this.clearDiagnostics();
    const byFile = new Map<string, vscode.Diagnostic[]>();
    for (const m of messages) {
      const file = m.location?.file ?? this.uri.fsPath;
      const line = Math.max((m.location?.line ?? 1) - 1, 0);
      const diag = new vscode.Diagnostic(
        new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER),
        m.message,
        m.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning,
      );
      diag.source = 'OpenSCAD';
      diag.relatedInformation = m.trace
        .filter((t) => t.location)
        .map(
          (t) =>
            new vscode.DiagnosticRelatedInformation(
              new vscode.Location(vscode.Uri.file(t.location!.file), new vscode.Position(t.location!.line - 1, 0)),
              t.message,
            ),
        );
      byFile.set(file, [...(byFile.get(file) ?? []), diag]);
    }
    for (const [file, diags] of byFile) {
      const uri = vscode.Uri.file(file);
      this.services.diagnostics.set(uri, diags);
      this.diagnosticFiles.push(uri);
    }
  }

  private clearDiagnostics(): void {
    for (const uri of this.diagnosticFiles) this.services.diagnostics.delete(uri);
    this.diagnosticFiles = [];
  }

  private logOutput(result: RenderResult): void {
    const out = this.services.output;
    const time = new Date().toLocaleTimeString();
    out.appendLine(`── ${path.basename(this.uri.fsPath)} · ${time} · ${(result.ms / 1000).toFixed(2)} s · exit ${result.exitCode}`);
    for (const echo of parseEchoes(result.output)) out.appendLine(`ECHO: ${echo}`);
    for (const line of result.output.split(/\r?\n/)) {
      if (/^(ERROR|WARNING|DEPRECATED|TRACE):/.test(line)) out.appendLine(line);
    }
    if (!result.ok && !result.empty) out.appendLine(result.output.trimEnd());
  }

  private setStatus(text: string, tooltip: string): void {
    this.statusText = text;
    this.statusTooltip = tooltip;
    this.updateStatusBar();
  }

  private updateStatusBar(): void {
    const bar = this.services.statusBar;
    if (!this.panel.active || !this.statusText) return;
    bar.text = this.statusText;
    bar.tooltip = this.statusTooltip;
    bar.show();
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
  <div id="toolbar">
    <button data-action="fit" title="Fit model in view">Fit</button>
    <span class="sep"></span>
    <button data-view="iso" title="Isometric view">Iso</button>
    <button data-view="top" title="View from +Z">Top</button>
    <button data-view="front" title="View from −Y">Front</button>
    <button data-view="right" title="View from +X">Right</button>
    <span class="sep"></span>
    <button data-toggle="ortho" title="Orthographic projection">Ortho</button>
    <button data-toggle="edges" title="Show facet edges">Edges</button>
    <span class="spacer"></span>
    <button data-action="rerender" title="Render again">Render</button>
  </div>
  <div id="viewport">
    <div id="badge" hidden></div>
    <div id="banner" hidden></div>
  </div>
  <div id="statusbar">
    <span id="file"></span>
    <span id="stats"></span>
    <span id="version">Checking OpenSCAD…</span>
  </div>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}

function lastLine(text: string): string | undefined {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
