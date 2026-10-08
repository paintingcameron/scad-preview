import type { FromWebview, ToWebview } from '../src/protocol';
import { buildModel } from './model';
import { parse3mf, parseHexColor, type MeshData, type Rgba } from './threemf';
import { Viewer, type ViewName } from './viewer';

declare function acquireVsCodeApi(): { postMessage(msg: FromWebview): void };
const vscode = acquireVsCodeApi();

const $ = (id: string): HTMLElement => document.getElementById(id)!;
const viewer = new Viewer($('viewport'));
const badge = $('badge');
const banner = $('banner');
let hasModel = false;
/** Last parsed model, kept so a settings change can redraw it without re-rendering. */
let lastData: MeshData | undefined;
let defaultColor: Rgba = parseHexColor('#ffffff');

const toggles = { ortho: false, edges: true };

for (const button of document.querySelectorAll<HTMLButtonElement>('#toolbar button')) {
  const { action, view, toggle } = button.dataset;
  if (toggle === 'ortho' || toggle === 'edges') button.classList.toggle('on', toggles[toggle]);
  button.addEventListener('click', () => {
    if (action === 'fit') viewer.fit();
    if (action === 'rerender') vscode.postMessage({ type: 'rerender' });
    if (view) viewer.setView(view as ViewName);
    if (toggle === 'ortho' || toggle === 'edges') {
      toggles[toggle] = !toggles[toggle];
      button.classList.toggle('on', toggles[toggle]);
      if (toggle === 'ortho') viewer.setOrthographic(toggles.ortho);
      else viewer.setEdges(toggles.edges);
    }
  });
}

function showBadge(text: string | undefined): void {
  badge.hidden = !text;
  badge.textContent = text ?? '';
}

function showBanner(text: string | undefined): void {
  banner.hidden = !text;
  banner.textContent = text ?? '';
}

function formatStats(facets: number | undefined, ms: number, errors: number, warnings: number): string {
  const parts = [facets !== undefined ? `${facets.toLocaleString()} facets` : undefined, `${(ms / 1000).toFixed(2)} s`];
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
      defaultColor = parseHexColor(msg.defaultColor);
      if (lastData) viewer.setModel(buildModel(lastData, defaultColor), false);
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
      showBadge('Rendering…');
      break;
    case 'renderDone': {
      showBadge(undefined);
      try {
        const started = performance.now();
        lastData = parse3mf(msg.model);
        viewer.setModel(buildModel(lastData, defaultColor), !hasModel);
        hasModel = true;
        showBanner(undefined);
        const loadMs = performance.now() - started;
        $('stats').textContent = formatStats(msg.facets, msg.ms, msg.errors, msg.warnings);
        $('stats').title = `OpenSCAD ${msg.ms} ms · load ${loadMs.toFixed(0)} ms`;
      } catch (err) {
        showBanner(`Could not read the rendered model: ${String(err)}`);
      }
      break;
    }
    case 'renderEmpty':
      showBadge(undefined);
      viewer.setModel(undefined, false);
      hasModel = false;
      lastData = undefined;
      showBanner(
        msg.firstProblem
          ? `The model is empty. First problem: ${msg.firstProblem}`
          : 'The model is empty: nothing to show.',
      );
      $('stats').textContent = formatStats(undefined, msg.ms, msg.errors, msg.warnings);
      break;
    case 'renderFailed':
      showBadge(undefined);
      // Keep the last good model on screen so a typo doesn't wipe the view.
      showBanner(`Render failed: ${msg.message}`);
      $('stats').textContent = `failed · ${(msg.ms / 1000).toFixed(2)} s`;
      break;
  }
});

vscode.postMessage({ type: 'ready' });
