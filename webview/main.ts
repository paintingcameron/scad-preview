import type { FromWebview, PreviewSettings, ToWebview } from '../src/protocol';
import { Customizer } from './customizer';
import { Measure } from './measure';
import { buildDebugParts, buildModel } from './model';
import type { SectionState } from './section';
import { SectionBar } from './sectionBar';
import { parse3mf, parseHexColor, type MeshData, type Rgba } from './threemf';
import { Viewer, type ViewName } from './viewer';

/** Per-panel UI state that VS Code keeps for us while the panel exists. */
interface UiState {
  paramsOpen?: boolean;
  section?: SectionState;
}

declare function acquireVsCodeApi(): {
  postMessage(msg: FromWebview): void;
  getState(): UiState | undefined;
  setState(state: UiState): void;
};
const vscode = acquireVsCodeApi();
const uiState: UiState = vscode.getState() ?? {};

const $ = (id: string): HTMLElement => document.getElementById(id)!;
const viewer = new Viewer($('viewport'));
const badge = $('badge');
const badgeText = $('badge-text');
const badgeCancel = $('badge-cancel') as HTMLButtonElement;
badgeCancel.addEventListener('click', () => vscode.postMessage({ type: 'cancelRender' }));
const banner = $('banner');
const paramsPanel = $('params');
const paramsButton = document.querySelector<HTMLButtonElement>('[data-toggle="params"]')!;
let hasModel = false;
/** Last parsed model, kept so a settings change can redraw it without re-rendering. */
let lastData: MeshData | undefined;
let defaultColor: Rgba = parseHexColor('#ffffff');

const customizer = new Customizer(paramsPanel, {
  change: (values, draft) => vscode.postMessage({ type: 'setParams', values, draft }),
  applyPreset: (name) => vscode.postMessage({ type: 'applyPreset', name }),
  savePreset: () => vscode.postMessage({ type: 'savePreset' }),
  deletePreset: () => vscode.postMessage({ type: 'deletePreset' }),
});

const measure = new Measure(viewer, $('viewport'), {
  toggle: document.querySelector<HTMLButtonElement>('[data-toggle="measure"]')!,
  card: $('measurecard'),
  tools: $('measure-tools'),
  readout: $('measure-readout'),
  hint: $('measure-hint'),
  list: $('measure-list'),
  clearAll: $('measure-clear') as HTMLButtonElement,
  listHead: $('measure-list-head'),
  allToggle: $('measure-all') as HTMLInputElement,
  entry: {
    box: $('measure-entry'),
    label: $('entry-label'),
    x: $('entry-x') as HTMLInputElement,
    y: $('entry-y') as HTMLInputElement,
    z: $('entry-z') as HTMLInputElement,
    relative: $('entry-relative') as HTMLInputElement,
    add: $('entry-add') as HTMLButtonElement,
  },
});

// Saved to .scad-preview/<model>.measure.json; batched so typing a name doesn't write every key.
let measureSaveTimer: ReturnType<typeof setTimeout> | undefined;
measure.onChange = () => {
  clearTimeout(measureSaveTimer);
  measureSaveTimer = setTimeout(() => vscode.postMessage({ type: 'saveMeasures', saved: measure.getSaved() }), 300);
};

const sectionBar = new SectionBar(
  $('sectionbar'),
  document.querySelector<HTMLButtonElement>('[data-toggle="section"]')!,
  uiState.section,
  (state) => {
    viewer.setSection(state);
    measure.setSection(state);
    uiState.section = state;
    vscode.setState(uiState);
  },
);
viewer.setSection(sectionBar.current);
measure.setSection(sectionBar.current);

function setParamsOpen(open: boolean): void {
  paramsPanel.hidden = !open || customizer.isEmpty;
  paramsButton.classList.toggle('on', open);
  uiState.paramsOpen = open;
  vscode.setState(uiState);
  layout();
}

/**
 * Place the floating panels on their sides (settings). The Section/Measure cards sit next to the
 * Parameters panel when both are on the same side; the view cube and badges keep clear of it.
 */
function layout(): void {
  const paramsLeft = settings?.parametersSide === 'left';
  const toolsRight = settings?.toolsSide === 'right';
  document.body.classList.toggle('params-left', paramsLeft);
  const paramsWidth = paramsPanel.hidden ? 0 : paramsPanel.offsetWidth;
  const offset = `${8 + (toolsRight !== paramsLeft ? paramsWidth : 0)}px`;
  const cards = $('left-cards');
  cards.style.left = toolsRight ? 'auto' : offset;
  cards.style.right = toolsRight ? offset : 'auto';
  viewer.setInsets(paramsLeft ? paramsWidth : 0, paramsLeft ? 0 : paramsWidth);
}

let settings: PreviewSettings | undefined;
/** The last # / % parts, kept so a color change can redraw them. */
let lastDebug: { highlight?: MeshData; background?: MeshData } = {};

function showDebugParts(): void {
  const parts = buildDebugParts(lastDebug, {
    highlight: settings?.highlightColor ?? '#ff3d6e',
    background: settings?.backgroundPartColor ?? '#b4b4b4',
  });
  viewer.setDebugParts(parts);
  debugButton.hidden = !parts;
}

/** Apply the scadPreview.* settings; they arrive when the panel opens and on every change. */
function applySettings(next: PreviewSettings): void {
  const first = settings === undefined;
  settings = next;
  const root = document.documentElement.style;
  if (next.fontSize > 0) root.setProperty('--ui-font-size', `${next.fontSize}px`);
  else root.removeProperty('--ui-font-size');
  root.setProperty('--tools-width', `${next.toolsWidth}px`);
  root.setProperty('--params-width', `${next.parametersWidth}px`);
  root.setProperty('--measure-color', next.measureColor);
  root.setProperty('--measure-code-color', next.codeMeasureColor);
  root.setProperty('--measure-label-size', `${next.measureLabelSize}px`);
  viewer.setBackground(next.background || undefined);
  viewer.configureViewCube({ ...next.viewCube, axes: next.axes });

  const color = parseHexColor(next.defaultColor);
  if (lastData && (color.r !== defaultColor.r || color.g !== defaultColor.g || color.b !== defaultColor.b)) {
    defaultColor = color;
    viewer.setModel(buildModel(lastData, defaultColor), false);
    measure.setModel(lastData.positions);
  }
  defaultColor = color;
  showDebugParts();
  // Projection and edges are where a preview starts; after that the toolbar buttons decide.
  if (first) {
    setToggle('ortho', next.orthographic);
    setToggle('edges', next.edges);
  }
  layout();
}

const toggles = { ortho: false, edges: true, debug: true };
type ToggleName = keyof typeof toggles;
const debugButton = document.querySelector<HTMLButtonElement>('[data-toggle="debug"]')!;
const DEBUG_BADGE = 'Finding # / % parts…';

/** Switch a toolbar toggle and what it controls. */
function setToggle(name: ToggleName, on: boolean): void {
  toggles[name] = on;
  document.querySelector(`[data-toggle="${name}"]`)?.classList.toggle('on', on);
  if (name === 'ortho') viewer.setOrthographic(on);
  else if (name === 'edges') viewer.setEdges(on);
  else viewer.setDebugVisible(on);
}

for (const button of document.querySelectorAll<HTMLButtonElement>('#toolbar button')) {
  const { action, view, toggle } = button.dataset;
  if (toggle && toggle in toggles) button.classList.toggle('on', toggles[toggle as ToggleName]);
  button.addEventListener('click', () => {
    if (action === 'fit') viewer.fit();
    if (action === 'rerender') vscode.postMessage({ type: 'rerender' });
    if (action === 'export') vscode.postMessage({ type: 'export' });
    if (view) viewer.setView(view as ViewName);
    if (toggle === 'params') setParamsOpen(paramsPanel.hidden);
    if (toggle && toggle in toggles) setToggle(toggle as ToggleName, !toggles[toggle as ToggleName]);
  });
}

let badgeTimer: ReturnType<typeof setInterval> | undefined;
/** How long the last full render took, to say roughly how long the next one will. */
let lastFullMs: number | undefined;

/**
 * The pill at the top right. `since` adds a running clock ("Rendering… 12 s of ~25 s");
 * `cancellable` adds a Cancel button.
 */
function showBadge(text: string | undefined, { since, cancellable = false }: { since?: number; cancellable?: boolean } = {}): void {
  clearInterval(badgeTimer);
  badgeTimer = undefined;
  badge.hidden = !text;
  badgeCancel.hidden = !cancellable;
  badge.dataset.text = text ?? '';
  const update = () => {
    const elapsed = since === undefined ? '' : ` ${Math.floor((performance.now() - since) / 1000)} s`;
    const estimate = since !== undefined && lastFullMs !== undefined && lastFullMs >= 2000 ? ` of ~${Math.round(lastFullMs / 1000)} s` : '';
    badgeText.textContent = `${text ?? ''}${elapsed}${estimate}`;
  };
  update();
  if (text && since !== undefined) badgeTimer = setInterval(update, 1000);
}

/** Above this the view gets sluggish on most machines (edges already switch off at 500k triangles). */
const LARGE_FACETS = 1_000_000;

function showBanner(text: string | undefined): void {
  banner.hidden = !text;
  banner.textContent = text ?? '';
}

function formatStats(facets: number | undefined, ms: number, errors: number, warnings: number, cached = false): string {
  const parts = [facets !== undefined ? `${facets.toLocaleString()} facets` : undefined, cached ? 'cached' : `${(ms / 1000).toFixed(2)} s`];
  if (errors) parts.push(`${errors} error${errors > 1 ? 's' : ''}`);
  if (warnings) parts.push(`${warnings} warning${warnings > 1 ? 's' : ''}`);
  return parts.filter(Boolean).join(' · ');
}

window.addEventListener('message', (event: MessageEvent<ToWebview>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'file':
      $('file').textContent = msg.name;
      break;
    case 'settings':
      applySettings(msg.settings);
      break;
    case 'params': {
      customizer.setParams(msg.defs, msg.values);
      paramsButton.hidden = customizer.isEmpty;
      // Open by default the first time a file with parameters is shown.
      setParamsOpen(uiState.paramsOpen ?? true);
      break;
    }
    case 'presets':
      customizer.setPresets(msg.names, msg.selected);
      break;
    case 'measures':
      measure.load(msg.saved);
      break;
    case 'status': {
      const el = $('version');
      el.textContent = msg.version ? `OpenSCAD ${msg.version}` : `OpenSCAD not found (${msg.openscadPath})`;
      el.title = msg.error ?? msg.openscadPath;
      el.classList.toggle('error', !msg.version);
      if (!msg.version) showBanner(`OpenSCAD could not be started. Set "scadPreview.openscadPath". ${msg.error ?? ''}`);
      break;
    }
    case 'renderStarted':
      // Drafts are quick and replace each other while dragging; only full renders get a clock and Cancel.
      showBadge(msg.draft ? 'Draft…' : 'Rendering…', msg.draft ? {} : { since: performance.now(), cancellable: true });
      break;
    case 'renderCancelled':
      showBadge(undefined);
      $('stats').textContent = 'cancelled';
      break;
    case 'captureScreenshot':
      void viewer
        .screenshot()
        .then((png) => vscode.postMessage({ type: 'screenshot', png }))
        .catch(() => vscode.postMessage({ type: 'screenshot' }));
      break;
    case 'renderDone': {
      if (!msg.draft && !msg.cached) lastFullMs = msg.ms;
      // A draft result stays labelled until the full render replaces it.
      showBadge(msg.draft ? 'Draft' : undefined);
      try {
        const started = performance.now();
        lastData = parse3mf(msg.model);
        viewer.setModel(buildModel(lastData, defaultColor), !hasModel);
        measure.setModel(lastData.positions);
        measure.setCodeMeasures(msg.measures);
        sectionBar.setBounds(viewer.bounds);
        hasModel = true;
        showBanner(undefined);
        const loadMs = performance.now() - started;
        const stats = $('stats');
        const large = (msg.facets ?? 0) > LARGE_FACETS;
        stats.textContent = `${formatStats(msg.facets, msg.ms, msg.errors, msg.warnings, msg.cached)}${msg.draft ? ' · draft' : ''}${large ? ' · large' : ''}`;
        stats.classList.toggle('warn', large);
        stats.title = [
          msg.cached ? `From the cache (rendered in ${msg.ms} ms)` : `OpenSCAD ${msg.ms} ms`,
          `load ${loadMs.toFixed(0)} ms`,
          large ? 'Over a million facets: turning and measuring may be slow' : '',
        ]
          .filter(Boolean)
          .join(' · ');
      } catch (err) {
        showBanner(`Could not read the rendered model: ${String(err)}`);
      }
      break;
    }
    case 'renderEmpty':
      showBadge(undefined);
      viewer.setModel(undefined, false);
      measure.setModel(undefined);
      hasModel = false;
      lastData = undefined;
      showBanner(
        msg.firstProblem
          ? `The model is empty. First problem: ${msg.firstProblem}`
          : 'The model is empty: nothing to show.',
      );
      $('stats').textContent = formatStats(undefined, msg.ms, msg.errors, msg.warnings);
      break;
    case 'debugStarted':
      showBadge(DEBUG_BADGE, { since: performance.now(), cancellable: true });
      break;
    case 'debugParts': {
      if (badge.dataset.text === DEBUG_BADGE) showBadge(undefined);
      try {
        lastDebug = {
          highlight: msg.highlight && parse3mf(msg.highlight),
          background: msg.background && parse3mf(msg.background),
        };
        showDebugParts();
      } catch (err) {
        showBanner(`Could not read the # / % parts: ${String(err)}`);
      }
      if (msg.failed) showBadge('Some # / % parts failed: see Output');
      break;
    }
    case 'renderFailed':
      showBadge(undefined);
      // Keep the last good model on screen so a typo doesn't wipe the view.
      showBanner(`Render failed: ${msg.message}`);
      $('stats').textContent = `failed · ${(msg.ms / 1000).toFixed(2)} s`;
      break;
  }
});

vscode.postMessage({ type: 'ready' });
