import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { defineArgs, parseCustomizer, pruneValues, type ParamDef, type ParamValue } from './customizer';
import { parse3mf } from '../webview/threemf';
import { unpackedAppImage } from './appimage';
import { DebugPass, type DebugParts } from './debugPass';
import { exportWithOpenscad } from './exporter';
import { loadMeasures, measurePath, saveMeasures } from './measureStore';
import { parseEchoes, parseMeasureEchoes, parseScadMessages, type ScadMessage } from './messages';
import { hasModifiers } from './modifiers';
import { getOpenscadVersion, resolveOpenscadPath } from './openscad';
import {
  parsePresetFile,
  presetPath,
  presetToValues,
  serializePresetFile,
  valuesToPreset,
  type PresetFile,
} from './presets';
import type { FromWebview, ToWebview } from './protocol';
import { RenderQueue, type RenderRequest, type RenderResult, type RequestOptions } from './renderer';
import { RenderCache } from './renderCache';
import { binaryStl } from './stl';

/** Finished renders of every panel, so earlier parameter values come back instantly. */
const renderCache = new RenderCache();

interface RenderOptions extends RequestOptions {
  draft?: boolean;
}

/** What the panel remembers per file between sessions. */
interface SavedParams {
  values: Record<string, ParamValue>;
  preset?: string;
}

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
  /** Second pass for `#` and `%` parts, after a full render. */
  private readonly debug = new DebugPass();
  private readonly disposables: vscode.Disposable[] = [];
  private exe?: string;
  /** Files the last successful render read; saving any of them re-renders. */
  private deps = new Set<string>();
  /** Files this panel has put diagnostics on, so they can be cleared before the next render. */
  private diagnosticFiles: vscode.Uri[] = [];
  private statusText = '';
  private statusTooltip = '';
  private statusCancellable = false;
  /** Customizer parameters read from the file, and the user's overrides of their defaults. */
  private defs: ParamDef[] = [];
  private defsKey = '';
  private values: Record<string, ParamValue> = {};
  private presets: PresetFile = parsePresetFile(undefined);
  private measureWrite: Promise<void> = Promise.resolve();
  private selectedPreset?: string;
  private renderSeq = 0;
  /** Counts results shown, so work for an older one (its # / % pass) can tell it was replaced. */
  private resultSeq = 0;
  /** Watchers on the folders of the files the last render read. */
  private watchers: vscode.FileSystemWatcher[] = [];
  private watchedKey = '';
  /** Waiting for the webview's screenshot. */
  private screenshotWaiter?: (png: Uint8Array | undefined) => void;

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
      (request) => this.onRenderStart(request),
      (result) => this.onRenderResult(result),
    );
    const saved = context.workspaceState.get<SavedParams>(this.stateKey);
    this.values = saved?.values ?? {};
    this.selectedPreset = saved?.preset;

    const presetWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(path.dirname(uri.fsPath), path.basename(presetPath(uri.fsPath))),
    );
    presetWatcher.onDidChange(() => void this.loadPresets());
    presetWatcher.onDidCreate(() => void this.loadPresets());
    presetWatcher.onDidDelete(() => void this.loadPresets());

    this.disposables.push(
      presetWatcher,
      this.panel.webview.onDidReceiveMessage((msg: FromWebview) => this.onMessage(msg)),
      this.panel.onDidChangeViewState(() => this.updateStatusBar()),
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (doc.uri.fsPath === this.uri.fsPath || this.deps.has(doc.uri.fsPath)) this.render();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('scadPreview.openscadPath') || e.affectsConfiguration('scadPreview.unpackAppImage')) {
          void this.resolveAndRender();
        }
        const display = ['defaultColor', 'appearance', 'layout', 'viewCube', 'axes', 'view'];
        if (display.some((key) => e.affectsConfiguration(`scadPreview.${key}`))) this.postSettings();
        if (e.affectsConfiguration('scadPreview.debugModifiers')) this.render({ delayMs: 0 });
      }),
    );
    this.panel.onDidDispose(() => this.dispose(), null, context.subscriptions);
  }

  private dispose(): void {
    PreviewPanel.panels.delete(this.uri.toString());
    this.queue.dispose();
    this.debug.dispose();
    this.clearDiagnostics();
    this.services.statusBar.hide();
    for (const d of [...this.disposables, ...this.watchers]) d.dispose();
    this.screenshotWaiter?.(undefined);
  }

  /** For the "cancel render" command and the status bar: the panel in front. */
  static cancelActive(): void {
    for (const panel of PreviewPanel.panels.values()) if (panel.panel.active) panel.cancelRender();
  }

  private post(msg: ToWebview): void {
    void this.panel.webview.postMessage(msg);
  }

  private onMessage(msg: FromWebview): void {
    switch (msg.type) {
      case 'ready':
        this.post({ type: 'file', name: path.basename(this.uri.fsPath) });
        this.postSettings();
        void this.loadPresets();
        void loadMeasures(this.uri.fsPath).then((saved) => this.post({ type: 'measures', saved }));
        void this.resolveAndRender();
        break;
      case 'saveMeasures': {
        // One write at a time, in order, so a slow write can't land after a newer one.
        const saved = msg.saved;
        this.measureWrite = this.measureWrite
          .then(() => saveMeasures(this.uri.fsPath, saved))
          .catch((err) => this.services.output.appendLine(`Could not save measurements to ${measurePath(this.uri.fsPath)}: ${String(err)}`));
        break;
      }
      case 'rerender':
        this.render({ delayMs: 0, fresh: true });
        break;
      case 'cancelRender':
        this.cancelRender();
        break;
      case 'export':
        void this.export();
        break;
      case 'screenshot':
        this.screenshotWaiter?.(msg.png);
        this.screenshotWaiter = undefined;
        break;
      case 'setParams':
        this.values = pruneValues(msg.values, this.defs);
        this.saveState();
        // While dragging: low-detail renders that never cancel each other. Otherwise: a full render.
        this.render(msg.draft ? { draft: true, delayMs: 0, interrupt: false } : { delayMs: 150 });
        break;
      case 'applyPreset':
        this.applyPreset(msg.name);
        break;
      case 'savePreset':
        void this.savePreset();
        break;
      case 'deletePreset':
        void this.deletePreset();
        break;
    }
  }

  private get stateKey(): string {
    return `params:${this.uri.toString()}`;
  }

  private saveState(): void {
    const state: SavedParams = { values: this.values, preset: this.selectedPreset };
    void this.context.workspaceState.update(this.stateKey, state);
  }

  /** Re-read the parameter comments and tell the webview if they changed. */
  private async refreshParams(): Promise<void> {
    let source = '';
    try {
      source = await fs.readFile(this.uri.fsPath, 'utf8');
    } catch {
      return; // Unreadable file: the render will report it.
    }
    const defs = parseCustomizer(source);
    const key = JSON.stringify(defs);
    if (key === this.defsKey) return;
    this.defs = defs;
    this.defsKey = key;
    this.values = pruneValues(this.values, defs);
    this.postParams();
  }

  private postParams(): void {
    this.post({ type: 'params', defs: this.defs, values: this.values });
  }

  private async loadPresets(): Promise<void> {
    let text: string | undefined;
    try {
      text = await fs.readFile(presetPath(this.uri.fsPath), 'utf8');
    } catch {
      text = undefined;
    }
    this.presets = parsePresetFile(text);
    if (this.selectedPreset && !(this.selectedPreset in this.presets.parameterSets)) this.selectedPreset = undefined;
    this.postPresets();
  }

  private postPresets(): void {
    this.post({ type: 'presets', names: Object.keys(this.presets.parameterSets), selected: this.selectedPreset });
  }

  private applyPreset(name: string | undefined): void {
    const set = name !== undefined ? this.presets.parameterSets[name] : undefined;
    this.selectedPreset = set ? name : undefined;
    this.values = set ? presetToValues(set, this.defs) : {};
    this.saveState();
    this.postParams();
    this.postPresets();
    this.render({ delayMs: 0 });
  }

  private async savePreset(): Promise<void> {
    const existing = Object.keys(this.presets.parameterSets);
    const name = await vscode.window.showInputBox({
      title: 'Save parameter preset',
      prompt: `Saved to ${path.basename(presetPath(this.uri.fsPath))}, which the OpenSCAD app also reads.`,
      value: this.selectedPreset ?? '',
      validateInput: (v) => {
        if (!v.trim()) return 'Enter a name.';
        if (existing.includes(v.trim()))
          return { message: `Replaces the existing preset "${v.trim()}".`, severity: vscode.InputBoxValidationSeverity.Warning };
        return undefined;
      },
    });
    if (!name?.trim()) return;
    // Re-read first so presets added elsewhere since we loaded aren't lost.
    await this.loadPresets();
    this.presets.parameterSets[name.trim()] = valuesToPreset(this.values, this.defs);
    await this.writePresets();
    this.selectedPreset = name.trim();
    this.saveState();
    this.postPresets();
  }

  private async deletePreset(): Promise<void> {
    const name = this.selectedPreset;
    if (!name) return;
    const answer = await vscode.window.showWarningMessage(`Delete preset "${name}"?`, { modal: true }, 'Delete');
    if (answer !== 'Delete') return;
    await this.loadPresets();
    delete this.presets.parameterSets[name];
    await this.writePresets();
    this.selectedPreset = undefined;
    this.saveState();
    this.postPresets();
  }

  private async writePresets(): Promise<void> {
    try {
      await fs.writeFile(presetPath(this.uri.fsPath), serializePresetFile(this.presets), 'utf8');
    } catch (err) {
      void vscode.window.showErrorMessage(`Could not save presets: ${String(err)}`);
    }
  }

  private postSettings(): void {
    const config = vscode.workspace.getConfiguration('scadPreview');
    const get = <T>(key: string, fallback: T): T => config.get<T>(key, fallback);
    this.post({
      type: 'settings',
      settings: {
        defaultColor: get('defaultColor', '#ffffff'),
        fontSize: get('appearance.fontSize', 0),
        background: get('appearance.background', ''),
        measureColor: get('appearance.measureColor', '#ffd24d'),
        codeMeasureColor: get('appearance.codeMeasureColor', '#8ee07a'),
        measureLabelSize: get('appearance.measureLabelSize', 13),
        highlightColor: get('appearance.highlightColor', '#ff3d6e'),
        backgroundPartColor: get('appearance.backgroundPartColor', '#b4b4b4'),
        toolsSide: get('layout.toolsSide', 'left'),
        toolsWidth: get('layout.toolsWidth', 260),
        parametersSide: get('layout.parametersSide', 'right'),
        parametersWidth: get('layout.parametersWidth', 300),
        viewCube: { show: get('viewCube.show', true), corner: get('viewCube.corner', 'bottom-right'), size: get('viewCube.size', 190) },
        axes: { show: get('axes.show', true), size: get('axes.size', 110) },
        orthographic: get('view.orthographic', false),
        edges: get('view.edges', true),
      },
    });
  }

  private async resolveAndRender(): Promise<void> {
    const setting = vscode.workspace.getConfiguration('scadPreview').get<string>('openscadPath', '');
    const searchDirs = [
      path.dirname(this.uri.fsPath),
      ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
    ];
    const found = resolveOpenscadPath(setting, searchDirs);
    let exe = found;
    if (/\.AppImage$/i.test(found) && vscode.workspace.getConfiguration('scadPreview').get<boolean>('unpackAppImage', true)) {
      this.setStatus('$(sync~spin) Unpacking OpenSCAD…', `${found}\nOnce per AppImage version; makes every render start faster.`);
      exe = (await unpackedAppImage(found, this.context.globalStorageUri.fsPath)) ?? found;
    }
    try {
      // The status names the AppImage the user knows about, even when its unpacked copy runs.
      this.post({ type: 'status', openscadPath: found, version: await getOpenscadVersion(exe) });
      this.exe = exe;
      this.render({ delayMs: 0 });
    } catch (err) {
      this.exe = undefined;
      this.post({ type: 'status', openscadPath: found, error: String(err) });
      this.setStatus('$(error) OpenSCAD not found', `${found}\n${String(err)}`);
    }
  }

  /** The request for the current values: full detail, or a draft while a slider is dragged. */
  private requestFor(exe: string, draft: boolean): RenderRequest {
    const args = defineArgs(this.values);
    const draftFn = vscode.workspace.getConfiguration('scadPreview').get<number>('draftFn', 16);
    const isDraft = draft && draftFn > 0;
    // Last -D wins, so this overrides any $fn the file or a parameter sets.
    if (isDraft) args.push('-D', `$fn=${draftFn}`);
    return { exe, file: this.uri.fsPath, args, draft: isDraft };
  }

  /**
   * Render the current values, or show a cached result for them at once. `fresh` (the Render button)
   * skips the cache.
   */
  private render({ draft = false, fresh = false, ...options }: RenderOptions & { fresh?: boolean } = {}): void {
    const seq = ++this.renderSeq;
    void (async () => {
      await this.refreshParams();
      // File reads can finish out of order; only the newest call may go on.
      if (!this.exe || seq !== this.renderSeq) return;
      const request = this.requestFor(this.exe, draft);
      if (!fresh) {
        const key = await renderCache.key(request.exe, request.args ?? [], [request.file, ...this.deps]);
        const hit = seq === this.renderSeq ? renderCache.get(key) : undefined;
        if (seq !== this.renderSeq) return;
        if (hit) {
          this.queue.cancel(); // whatever it was rendering is no longer wanted
          this.showResult({ ...hit.result, request }, true);
          if (!request.draft) void this.followUp({ ...hit.result, request }, key, hit.debug);
          return;
        }
      }
      this.queue.request(request, options);
    })();
  }

  private onRenderStart(request: RenderRequest): void {
    this.debug.cancel(); // its parts would be for the model being replaced
    this.post({ type: 'renderStarted', draft: request.draft ?? false });
    this.setStatus(request.draft ? '$(sync~spin) Draft…' : '$(sync~spin) Rendering…', `${path.basename(this.uri.fsPath)}\nClick to cancel`, true);
  }

  private onRenderResult(result: RenderResult): void {
    this.showResult(result, false);
    if (!result.ok && !result.empty) return;
    const seq = this.resultSeq;
    void (async () => {
      // Stored under the files this render actually read, so any of them changing misses the cache.
      const key = await renderCache.key(result.request.exe, result.request.args ?? [], result.deps.length > 0 ? result.deps : [result.request.file]);
      renderCache.set(key, result);
      if (!result.request.draft && seq === this.resultSeq) await this.followUp(result, key);
    })();
  }

  /** Show a render result (fresh or from the cache) in the panel, the editor and the status bar. */
  private showResult(result: RenderResult, cached: boolean): void {
    this.resultSeq++;
    this.debug.cancel(); // its parts would be for the model being replaced
    const name = path.basename(this.uri.fsPath);
    const messages = parseScadMessages(result.output, this.uri.fsPath);
    const errors = messages.filter((m) => m.severity === 'error').length;
    const warnings = messages.length - errors;
    this.showDiagnostics(messages);
    this.logOutput(result, cached);
    if (result.deps.length > 0) {
      this.deps = new Set(result.deps);
      this.watchDeps(result.deps);
    }

    const seconds = cached ? 'cached' : `${(result.ms / 1000).toFixed(2)} s`;
    const problems = errors + warnings > 0 ? ` · ${errors} error(s), ${warnings} warning(s)` : '';
    if (result.ok && result.model) {
      const facets = result.summary?.geometry?.facets;
      const draft = result.request.draft ?? false;
      const { measures } = parseMeasureEchoes(parseEchoes(result.output));
      this.post({ type: 'renderDone', model: result.model, facets, ms: result.ms, errors, warnings, draft, measures, cached });
      const icon = errors > 0 || warnings > 0 ? '$(warning)' : '$(check)';
      this.setStatus(`${icon} ${facets ?? '?'} facets · ${seconds}${draft ? ' · draft' : ''}`, `${name}${problems}`);
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

  /**
   * After a full render: the `#` / `%` parts, from the cache when they were found before.
   * A model of only `%` parts renders empty, so empty results get this too.
   */
  private async followUp(result: RenderResult, key: string, cachedDebug?: DebugParts): Promise<void> {
    if (cachedDebug) {
      this.postDebugParts(cachedDebug);
      return;
    }
    const parts = await this.runDebugPass(result);
    if (parts) renderCache.setDebug(key, parts);
  }

  /**
   * Find `#` and `%` parts with a second, slower pass, when the file or one beside it uses them.
   * Library files are not scanned: BOSL2 and others define helpers with these modifiers, which would
   * otherwise start the pass for every model that includes them. Undefined when cancelled.
   */
  private async runDebugPass(result: RenderResult): Promise<DebugParts | undefined> {
    const seq = this.resultSeq;
    const enabled = vscode.workspace.getConfiguration('scadPreview').get<boolean>('debugModifiers', true);
    const folder = path.dirname(this.uri.fsPath) + path.sep;
    const own = [this.uri.fsPath, ...result.deps.filter((f) => f.startsWith(folder))];
    const sources = await Promise.all([...new Set(own)].map((f) => fs.readFile(f, 'utf8').catch(() => '')));
    if (seq !== this.resultSeq) return undefined;
    if (!enabled || !sources.some(hasModifiers)) {
      const none: DebugParts = { errors: [] };
      this.postDebugParts(none);
      return enabled ? none : undefined; // "off" isn't cached, so turning it on finds them
    }
    this.post({ type: 'debugStarted' });
    const { exe, file, args } = result.request;
    const parts = await this.debug.run({ exe, file, args });
    if (!parts || seq !== this.resultSeq) return undefined; // cancelled by a newer render
    for (const error of parts.errors) this.services.output.appendLine(`# / % parts: ${error}`);
    this.postDebugParts(parts);
    return parts.errors.length > 0 ? undefined : parts; // failures are retried next time
  }

  private postDebugParts(parts: DebugParts): void {
    this.post({ type: 'debugParts', highlight: parts.highlight, background: parts.background, failed: parts.errors.length > 0 });
  }

  /**
   * Re-render when any file the model reads changes on disk, including changes made outside VS Code
   * (git, another editor) and in library folders. One watcher per folder.
   */
  private watchDeps(files: string[]): void {
    const key = [...files].sort().join('\n');
    if (key === this.watchedKey) return;
    this.watchedKey = key;
    for (const w of this.watchers) w.dispose();
    this.watchers = [];
    const byDir = new Map<string, string[]>();
    for (const f of files) byDir.set(path.dirname(f), [...(byDir.get(path.dirname(f)) ?? []), path.basename(f)]);
    for (const [dir, names] of byDir) {
      const pattern = names.length === 1 ? names[0] : `{${names.join(',')}}`;
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(dir), pattern));
      const changed = () => this.render();
      watcher.onDidChange(changed);
      watcher.onDidCreate(changed);
      watcher.onDidDelete(changed);
      this.watchers.push(watcher);
    }
  }

  /**
   * Save a screenshot, or the model with the current parameter values as STL or 3MF. Meshes come
   * from the cache when the full-detail render of these values is there (instant); otherwise
   * OpenSCAD writes the file, with a cancellable progress notification.
   */
  private async export(): Promise<void> {
    const formats = [
      { label: 'Screenshot (PNG)', ext: 'png', detail: 'The view as shown, without the panels' },
      { label: 'STL', ext: 'stl', detail: 'Mesh for slicers, without colors' },
      { label: '3MF', ext: '3mf', detail: 'Mesh with colors' },
    ];
    const pick = await vscode.window.showQuickPick(formats, { title: `Export ${path.basename(this.uri.fsPath)}` });
    if (!pick) return;
    const base = path.basename(this.uri.fsPath, '.scad');
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(path.dirname(this.uri.fsPath), `${base}.${pick.ext}`)),
      filters: { [pick.label]: [pick.ext] },
    });
    if (!target) return;

    try {
      if (pick.ext === 'png') {
        const png = await new Promise<Uint8Array | undefined>((resolve) => {
          this.screenshotWaiter?.(undefined);
          this.screenshotWaiter = resolve;
          this.post({ type: 'captureScreenshot' });
        });
        if (!png) throw new Error('the preview did not send a picture');
        await fs.writeFile(target.fsPath, png);
      } else if (!(await this.exportFromCache(pick.ext, target.fsPath))) {
        await this.exportWithProgress(target.fsPath);
      }
      const reveal = 'Show in folder';
      void vscode.window.showInformationMessage(`Saved ${path.basename(target.fsPath)}`, reveal).then((choice) => {
        if (choice === reveal) void vscode.commands.executeCommand('revealFileInOS', target);
      });
    } catch (err) {
      if (!(err instanceof vscode.CancellationError)) void vscode.window.showErrorMessage(`Export failed: ${String(err)}`);
    }
  }

  /** Write the cached full-detail model of the current values, if there is one. */
  private async exportFromCache(ext: string, file: string): Promise<boolean> {
    if (!this.exe) return false;
    const request = this.requestFor(this.exe, false);
    const key = await renderCache.key(request.exe, request.args ?? [], [request.file, ...this.deps]);
    const model = renderCache.get(key)?.result.model;
    if (!model) return false;
    await fs.writeFile(file, ext === '3mf' ? model : binaryStl(parse3mf(model).positions, `scad-preview ${path.basename(this.uri.fsPath)}`));
    return true;
  }

  private async exportWithProgress(file: string): Promise<void> {
    const exe = this.exe;
    if (!exe) throw new Error('OpenSCAD was not found');
    const request = this.requestFor(exe, false);
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Rendering ${path.basename(file)}…`, cancellable: true },
      async (_progress, token) => {
        const abort = new AbortController();
        token.onCancellationRequested(() => abort.abort());
        const { ok, output } = await exportWithOpenscad(exe, request.file, request.args ?? [], file, abort.signal);
        if (abort.signal.aborted) throw new vscode.CancellationError();
        if (!ok) {
          this.services.output.appendLine(`── export ${path.basename(file)} failed\n${output.trimEnd()}`);
          throw new Error(lastLine(output) || 'OpenSCAD failed; see the SCAD Preview output');
        }
      },
    );
  }

  /** Stop the render and the `#` / `%` pass in progress. */
  cancelRender(): void {
    if (!this.queue.busy && !this.debug.busy) return;
    this.renderSeq++; // a render still waiting for its file reads won't start either
    this.queue.cancel();
    this.debug.cancel();
    this.resultSeq++;
    this.post({ type: 'renderCancelled' });
    this.setStatus('$(circle-slash) Render cancelled', `${path.basename(this.uri.fsPath)}\nSave or press Render to render again`);
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

  private logOutput(result: RenderResult, cached: boolean): void {
    const out = this.services.output;
    const time = new Date().toLocaleTimeString();
    const how = cached ? `cached (took ${(result.ms / 1000).toFixed(2)} s)` : `${(result.ms / 1000).toFixed(2)} s`;
    out.appendLine(`── ${path.basename(this.uri.fsPath)} · ${time} · ${how} · exit ${result.exitCode}`);
    const echoes = parseEchoes(result.output);
    for (const echo of echoes) out.appendLine(`ECHO: ${echo}`);
    for (const bad of parseMeasureEchoes(echoes).bad) {
      out.appendLine(`Ignored measure echo (expected "measure", [x, y, z], [x, y, z], "label"): ${bad}`);
    }
    for (const line of result.output.split(/\r?\n/)) {
      if (/^(ERROR|WARNING|DEPRECATED|TRACE):/.test(line)) out.appendLine(line);
    }
    if (!result.ok && !result.empty) out.appendLine(result.output.trimEnd());
  }

  /** `cancellable`: while rendering, clicking the status bar item cancels instead of showing the output. */
  private setStatus(text: string, tooltip: string, cancellable = false): void {
    this.statusText = text;
    this.statusTooltip = tooltip;
    this.statusCancellable = cancellable;
    this.updateStatusBar();
  }

  private updateStatusBar(): void {
    const bar = this.services.statusBar;
    if (!this.panel.active || !this.statusText) return;
    bar.text = this.statusText;
    bar.tooltip = this.statusTooltip;
    bar.command = this.statusCancellable ? 'scadPreview.cancelRender' : 'scadPreview.showOutput';
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
    <button data-toggle="debug" title="Show the parts marked # (highlight) and % (background) in the code" hidden>Debug parts</button>
    <button data-toggle="section" title="Cut the model with a plane">Section</button>
    <button data-toggle="measure" title="Measure distances">Measure</button>
    <span class="spacer"></span>
    <button data-action="export" title="Save a screenshot, or the model as STL or 3MF">Export…</button>
    <button data-action="rerender" title="Render again, ignoring the cache">Render</button>
    <button data-toggle="params" title="Show customizer parameters" hidden>Parameters</button>
  </div>
  <div id="main">
    <div id="left-cards">
    <div id="sectionbar" class="card" hidden>
      <div class="panel-title">Section</div>
      <div class="field-label">Cut along</div>
      <div class="axis-row">
        <button data-axis="x" title="Plane across X">X</button>
        <button data-axis="y" title="Plane across Y">Y</button>
        <button data-axis="z" title="Plane across Z">Z</button>
      </div>
      <div class="field-label">Position</div>
      <input id="section-slider" type="range" title="Plane position">
      <div class="value-row">
        <input id="section-value" type="number" step="any" title="Plane position (mm)">
        <span class="unit">mm</span>
      </div>
      <button id="section-flip" class="wide">Flip side</button>
    </div>
    <div id="measurecard" class="card" hidden>
      <div class="panel-title">Measure</div>
      <div id="measure-tools" class="segmented">
        <button data-tool="distance" title="Distance between two points. Snaps near corners, hole centres and edges; hold Alt for a free point. Esc cancels.">Distance</button>
        <button data-tool="wall" title="Wall thickness: click one side and get the distance straight through the material to the other">Wall</button>
        <button data-tool="angle" title="Angle between three points: an arm, the corner, the other arm">Angle</button>
        <button data-tool="box" title="Size of an outline or hole on the cut (Ø when round), of the whole cut, or of the whole model">Box</button>
      </div>
      <div id="measure-hint" class="hint"></div>
      <div id="measure-readout" class="readout"></div>
      <div id="measure-entry" class="entry">
        <div class="entry-head">
          <span id="entry-label" class="field-label">First point</span>
          <label title="Offset from the previous point instead of absolute coordinates"><input id="entry-relative" type="checkbox"> relative</label>
        </div>
        <div class="xyz">
          <input id="entry-x" type="number" step="any" title="X" placeholder="X">
          <input id="entry-y" type="number" step="any" title="Y" placeholder="Y">
          <input id="entry-z" type="number" step="any" title="Z" placeholder="Z">
          <button id="entry-add" title="Add this point (Enter)">Add</button>
        </div>
      </div>
      <div id="measure-list-head" class="list-head" hidden>
        <label title="Show or hide every measurement on the model"><input id="measure-all" type="checkbox"> All</label>
        <button id="measure-clear" title="Remove the measurements you added (code ones come from the file)">Clear</button>
      </div>
      <div id="measure-list"></div>
    </div>
    </div>
    <div id="viewport">
      <div id="badge" hidden><span id="badge-text"></span><button id="badge-cancel" title="Stop this render (also: click the status bar item)" hidden>Cancel</button></div>
      <div id="banner" hidden></div>
    </div>
    <div id="params" hidden></div>
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
