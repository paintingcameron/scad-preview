import * as THREE from 'three';
import type { SavedMeasures } from '../src/measureStore';
import type { CodeMeasure } from '../src/messages';
import type { SectionState } from './section';
import { findSnap, PLANE_AXES, sliceMesh, type AxisIndex, type Circle, type Slice, type SnapKind } from './slice';
import type { Viewer } from './viewer';

const AXIS_INDEX: Record<SectionState['axis'], AxisIndex> = { x: 0, y: 1, z: 2 };
const AXIS_NAMES = 'XYZ';
/** Snap when a feature is within this many screen pixels of the cursor. */
const SNAP_PX = 10;
/** A press that moves less than this is a click; more is an orbit drag. */
const CLICK_SLOP_PX = 4;

interface MeasurePoint {
  world: THREE.Vector3;
  /** What it snapped to; undefined for a free point. */
  snap?: SnapKind;
  /** The circle it snapped to or onto, for showing a diameter. */
  circle?: Circle;
}

interface Measurement {
  id: number;
  a: MeasurePoint;
  b: MeasurePoint;
  /** Set for measurements from `echo("measure", …)`; these are owned by the file, not the list. */
  fromCode?: boolean;
  label?: string;
  /** Listed but not drawn. */
  hidden?: boolean;
}

export interface MeasureElements {
  /** Toolbar button that opens and closes the card. Clicks on the model add points only while it is open. */
  toggle: HTMLButtonElement;
  /** Floating card holding everything below. */
  card: HTMLElement;
  readout: HTMLElement;
  list: HTMLElement;
  clearAll: HTMLButtonElement;
  /** Row holding Show all / Hide all; shown only when there is something listed. */
  listActions: HTMLElement;
  showAll: HTMLButtonElement;
  hideAll: HTMLButtonElement;
  /** Manual point entry. */
  entry: {
    label: HTMLElement;
    x: HTMLInputElement;
    y: HTMLInputElement;
    z: HTMLInputElement;
    relative: HTMLInputElement;
    add: HTMLButtonElement;
  };
}

/**
 * Point-to-point measuring.
 * - Section on: clicks land on the cut plane (never a surface behind it) and snap to the cut outline.
 * - Section off: clicks land on the model surface and snap to a nearby mesh corner.
 * Snapping only happens near a feature; Alt turns it off. Results are listed in the card and drawn
 * in an SVG overlay that follows the camera.
 */
export class Measure {
  private active = false;
  private section: SectionState = { enabled: false, axis: 'z', offset: 0, flipped: false };
  private positions?: ArrayLike<number>;
  private slice?: Slice;
  private sliceKey = '';
  private measurements: Measurement[] = [];
  /** Replaced on every render; listed and drawn before the clicked ones. */
  private codeMeasurements: Measurement[] = [];
  /** Keys (see codeKey) of code measurements the user hid. */
  private readonly hiddenCode = new Set<string>();
  private nextId = 1;
  private pending?: MeasurePoint;
  private hover?: MeasurePoint;
  private highlighted?: number;
  /** Measurement whose coordinates are open for editing in the list. */
  private expanded?: number;
  private pressedAt?: { x: number; y: number };
  private readonly svg: SVGSVGElement;
  private readonly raycaster = new THREE.Raycaster();
  /** Called after any change worth saving (added, removed, renamed, moved, shown or hidden). */
  onChange?: () => void;

  constructor(
    private readonly viewer: Viewer,
    overlayParent: HTMLElement,
    private readonly el: MeasureElements,
  ) {
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.id = 'measure-overlay';
    overlayParent.append(this.svg);

    el.toggle.addEventListener('click', () => this.setActive(!this.active));
    el.clearAll.addEventListener('click', () => {
      this.measurements = [];
      this.setPending(undefined);
      this.renderList();
      this.onChange?.();
    });
    el.showAll.addEventListener('click', () => this.setHidden(this.all(), false));
    el.hideAll.addEventListener('click', () => this.setHidden(this.all(), true));

    const { entry } = el;
    entry.add.addEventListener('click', () => this.addFromEntry());
    for (const input of [entry.x, entry.y, entry.z]) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') this.addFromEntry();
        e.stopPropagation(); // keep Esc in a field from cancelling the pending point
      });
    }
    entry.relative.addEventListener('change', () => this.syncEntry());

    const canvas = viewer.canvas;
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button === 0) this.pressedAt = { x: e.clientX, y: e.clientY };
    });
    canvas.addEventListener('pointerup', (e) => {
      const press = this.pressedAt;
      this.pressedAt = undefined;
      if (!this.active || e.button !== 0 || !press) return;
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > CLICK_SLOP_PX) return; // that was an orbit drag
      const point = this.pointAt(e);
      if (point) this.addPoint(point);
    });
    canvas.addEventListener('pointermove', (e) => {
      this.hover = this.active && e.buttons === 0 ? this.pointAt(e) : undefined;
    });
    canvas.addEventListener('pointerleave', () => (this.hover = undefined));
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.setPending(undefined);
    });

    viewer.onFrame(() => this.draw());
    this.setActive(false);
    this.renderList();
  }

  /** A clicked or typed point: starts a measurement, or completes the one in progress. */
  private addPoint(point: MeasurePoint): void {
    if (!this.pending) {
      this.setPending(point);
      return;
    }
    this.measurements.push({ id: this.nextId++, a: this.pending, b: point });
    this.setPending(undefined);
    this.renderList();
    this.onChange?.();
  }

  /** What to save: the user's measurements (code ones come from the file) and which code ones are hidden. */
  getSaved(): SavedMeasures {
    const vec = (p: MeasurePoint): [number, number, number] => [p.world.x, p.world.y, p.world.z];
    return {
      measurements: this.measurements.map((m) => ({
        a: vec(m.a),
        b: vec(m.b),
        ...(m.label ? { label: m.label } : {}),
        ...(m.hidden ? { hidden: true } : {}),
      })),
      hiddenCode: [...this.hiddenCode],
    };
  }

  /** Replace the user's measurements with saved ones. */
  load(saved: SavedMeasures): void {
    this.measurements = saved.measurements.map((m) => ({
      id: this.nextId++,
      a: { world: new THREE.Vector3(...m.a) },
      b: { world: new THREE.Vector3(...m.b) },
      label: m.label,
      hidden: m.hidden,
    }));
    this.hiddenCode.clear();
    for (const key of saved.hiddenCode) this.hiddenCode.add(key);
    for (const m of this.codeMeasurements) m.hidden = this.hiddenCode.has(this.codeKey(m));
    this.renderList();
    if (!this.pending) this.syncEntry();
  }

  private setPending(point: MeasurePoint | undefined): void {
    this.pending = point;
    this.syncEntry();
  }

  /** Point from the X/Y/Z fields; with "relative", an offset from the first point. */
  private addFromEntry(): void {
    const { x, y, z, relative } = this.el.entry;
    const offset = relative.checked && this.pending !== undefined;
    const base = offset ? this.pending!.world : new THREE.Vector3();
    const values = [x, y, z].map((input, i) => {
      const n = Number(input.value);
      return input.value.trim() !== '' && Number.isFinite(n) ? n : offset ? 0 : base.getComponent(i);
    });
    const world = new THREE.Vector3(...values);
    if (offset) world.add(base);
    this.addPoint({ world });
  }

  /** Label and pre-fill the entry fields for the next point. */
  private syncEntry(): void {
    const { label, x, y, z, relative } = this.el.entry;
    label.textContent = this.pending ? 'Second point' : 'First point';
    relative.disabled = !this.pending;
    if (!this.pending) relative.checked = false;
    let fill: THREE.Vector3;
    if (relative.checked) {
      fill = new THREE.Vector3();
    } else {
      // Start from the last point used, so typically only one value needs changing.
      fill = this.pending?.world.clone() ?? this.measurements.at(-1)?.b.world.clone() ?? new THREE.Vector3();
      if (!this.pending && this.section.enabled) fill.setComponent(AXIS_INDEX[this.section.axis], this.section.offset);
    }
    [x, y, z].forEach((input, i) => (input.value = String(round(fill.getComponent(i)))));
  }

  setActive(active: boolean): void {
    this.active = active;
    if (!active) {
      this.setPending(undefined);
      this.hover = undefined;
    }
    this.el.toggle.classList.toggle('on', active);
    this.el.card.hidden = !active;
    this.viewer.canvas.classList.toggle('measuring', active);
  }

  setSection(state: SectionState): void {
    this.section = { ...state };
    if (!this.pending) this.syncEntry();
  }

  /** Measurements the model echoed; they replace the previous render's. */
  setCodeMeasures(measures: CodeMeasure[]): void {
    this.codeMeasurements = measures.map((m) => ({
      id: this.nextId++,
      a: { world: new THREE.Vector3(...m.a) },
      b: { world: new THREE.Vector3(...m.b) },
      fromCode: true,
      label: m.label,
    }));
    for (const m of this.codeMeasurements) m.hidden = this.hiddenCode.has(this.codeKey(m));
    this.renderList();
  }

  private all(): Measurement[] {
    return [...this.codeMeasurements, ...this.measurements];
  }

  /** A new model needs a new cut outline; existing measurements stay. */
  setModel(positions: ArrayLike<number> | undefined): void {
    this.positions = positions;
    this.sliceKey = '';
  }

  private planeAxes(): { axis: AxisIndex; u: AxisIndex; v: AxisIndex } {
    const axis = AXIS_INDEX[this.section.axis];
    const [u, v] = PLANE_AXES[axis];
    return { axis, u, v };
  }

  private currentSlice(): Slice | undefined {
    if (!this.positions) return undefined;
    const key = `${this.section.axis}:${this.section.offset}`;
    if (key !== this.sliceKey) {
      this.slice = sliceMesh(this.positions, AXIS_INDEX[this.section.axis], this.section.offset);
      this.sliceKey = key;
    }
    return this.slice;
  }

  /** Canvas pixel position of a world point, or undefined when it is behind the camera. */
  private toScreen(world: THREE.Vector3): { x: number; y: number } | undefined {
    const ndc = world.clone().project(this.viewer.activeCamera);
    if (ndc.z < -1 || ndc.z > 1) return undefined;
    const { clientWidth: w, clientHeight: h } = this.viewer.canvas;
    return { x: ((ndc.x + 1) / 2) * w, y: ((1 - ndc.y) / 2) * h };
  }

  private pointAt(e: PointerEvent): MeasurePoint | undefined {
    const rect = this.viewer.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    // The camera may have moved since the last frame (e.g. a view button just clicked).
    this.viewer.activeCamera.updateMatrixWorld();
    this.raycaster.setFromCamera(ndc, this.viewer.activeCamera);
    const cursor = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    return this.section.enabled ? this.pointOnSection(e.altKey) : this.pointOnSurface(e.altKey, cursor);
  }

  /** Section on: the ray meets the cut plane, then snaps to the cut outline. */
  private pointOnSection(free: boolean): MeasurePoint | undefined {
    const { axis, u, v } = this.planeAxes();
    const normal = new THREE.Vector3().setComponent(axis, 1);
    const hit = this.raycaster.ray.intersectPlane(new THREE.Plane(normal, -this.section.offset), new THREE.Vector3());
    if (!hit) return undefined;
    const slice = free ? undefined : this.currentSlice();
    if (!slice) return { world: hit };

    // Convert the pixel radius to mm at this spot on the plane.
    const here = this.toScreen(hit);
    const along = this.toScreen(hit.clone().setComponent(u, hit.getComponent(u) + 1));
    const pxPerMm = here && along ? Math.hypot(along.x - here.x, along.y - here.y) : 0;
    if (pxPerMm <= 0) return { world: hit };
    const snap = findSnap(slice, hit.getComponent(u), hit.getComponent(v), SNAP_PX / pxPerMm);
    if (!snap) return { world: hit };
    const world = hit.clone().setComponent(u, snap.u).setComponent(v, snap.v);
    return { world, snap: snap.kind, circle: snap.loop.circle };
  }

  /** Section off: the ray meets the model surface, then snaps to a corner of the triangle it hit. */
  private pointOnSurface(free: boolean, cursor: { x: number; y: number }): MeasurePoint | undefined {
    const hit = this.viewer.pickModel(this.raycaster);
    if (!hit) return undefined;
    if (free || !hit.face) return { world: hit.point.clone() };
    const position = (hit.object as THREE.Mesh).geometry.getAttribute('position');
    let best: THREE.Vector3 | undefined;
    let bestDist = SNAP_PX;
    for (const index of [hit.face.a, hit.face.b, hit.face.c]) {
      const corner = new THREE.Vector3().fromBufferAttribute(position, index).applyMatrix4(hit.object.matrixWorld);
      const s = this.toScreen(corner);
      const d = s ? Math.hypot(s.x - cursor.x, s.y - cursor.y) : Infinity;
      if (d <= bestDist) {
        best = corner;
        bestDist = d;
      }
    }
    return best ? { world: best, snap: 'vertex' } : { world: hit.point.clone() };
  }

  private renderList(): void {
    const rows = this.all().map((m, i) => this.buildRow(m, i + 1));
    if (rows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'measure-empty';
      empty.textContent = 'No measurements yet.';
      rows.push(empty);
    }
    this.el.list.replaceChildren(...rows);
    this.el.clearAll.disabled = this.measurements.length === 0;
    const all = this.all();
    this.el.listActions.hidden = all.length === 0;
    this.el.showAll.disabled = all.every((m) => !m.hidden);
    this.el.hideAll.disabled = all.every((m) => m.hidden);
  }

  private setHidden(list: Measurement[], hidden: boolean): void {
    for (const m of list) {
      m.hidden = hidden;
      // Code measurements are rebuilt on every render; remember the choice by their name.
      if (m.fromCode) {
        const key = this.codeKey(m);
        if (hidden) this.hiddenCode.add(key);
        else this.hiddenCode.delete(key);
      }
    }
    this.renderList();
    this.onChange?.();
  }

  /** Stable across renders: the label, or the position among the file's measurements. */
  private codeKey(m: Measurement): string {
    return m.label ?? `#${this.codeMeasurements.indexOf(m)}`;
  }

  /** One list entry: a summary line (click to open the coordinates for editing) and a remove button. */
  private buildRow(m: Measurement, number: number): HTMLElement {
    const row = document.createElement('div');
    row.className = 'measure-item';
    row.classList.toggle('open', this.expanded === m.id);
    row.addEventListener('mouseenter', () => (this.highlighted = m.id));
    row.addEventListener('mouseleave', () => (this.highlighted = undefined));

    const head = document.createElement('div');
    head.className = 'measure-head';
    row.classList.toggle('off', !!m.hidden);
    const show = document.createElement('input');
    show.type = 'checkbox';
    show.checked = !m.hidden;
    show.title = 'Show on the model';
    show.addEventListener('click', (e) => e.stopPropagation()); // not a click on the row
    show.addEventListener('change', () => this.setHidden([m], !show.checked));
    const summary = document.createElement('span');
    summary.className = 'summary';
    const updateSummary = () => {
      const labelHtml = m.label ? ` ${escapeHtml(m.label)}` : '';
      summary.innerHTML = `<b>${number}.${labelHtml}</b> ${fmt(m.a.world.distanceTo(m.b.world))} mm <span class="deltas">${deltaText(m)}</span>`;
    };
    updateSummary();
    if (m.fromCode) {
      // The file decides these points, so they are changed by editing the file, not here.
      row.classList.add('code');
      head.title = `From echo("measure", …) in the file\nA ${pointText(m.a)}\nB ${pointText(m.b)}`;
      const tag = document.createElement('span');
      tag.className = 'code-tag';
      tag.textContent = 'code';
      head.append(show, summary, tag);
      row.append(head);
      return row;
    }
    head.title = 'Click to edit the name and points';
    head.addEventListener('click', () => {
      this.expanded = this.expanded === m.id ? undefined : m.id;
      this.renderList();
    });
    const remove = document.createElement('button');
    remove.textContent = '×';
    remove.title = 'Remove this measurement';
    remove.addEventListener('click', (e) => {
      e.stopPropagation();
      this.measurements = this.measurements.filter((x) => x !== m);
      this.highlighted = undefined;
      this.renderList();
      this.onChange?.();
    });
    head.append(show, summary, remove);
    row.append(head);

    if (this.expanded === m.id) {
      // Name shown in the list and on the model; empty means just the number.
      const nameRow = document.createElement('div');
      nameRow.className = 'name-row';
      const nameLabel = document.createElement('span');
      nameLabel.className = 'point-name';
      nameLabel.textContent = 'Name';
      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.placeholder = String(number);
      nameInput.value = m.label ?? '';
      nameInput.addEventListener('input', () => {
        m.label = nameInput.value.trim() || undefined;
        updateSummary();
        this.onChange?.();
      });
      nameInput.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') nameInput.blur();
      });
      nameRow.append(nameLabel, nameInput);
      row.append(nameRow);

      for (const [name, point] of [['A', m.a], ['B', m.b]] as const) {
        const line = document.createElement('div');
        line.className = 'xyz';
        const label = document.createElement('span');
        label.className = 'point-name';
        label.textContent = name;
        line.append(label);
        for (const i of [0, 1, 2]) {
          const input = document.createElement('input');
          input.type = 'number';
          input.step = 'any';
          input.title = `${name} ${AXIS_NAMES[i]}`;
          input.value = String(round(point.world.getComponent(i)));
          input.addEventListener('change', () => {
            const n = Number(input.value);
            if (input.value.trim() === '' || !Number.isFinite(n)) {
              input.value = String(round(point.world.getComponent(i)));
              return;
            }
            point.world.setComponent(i, n);
            // Typed in, so it no longer sits on whatever it snapped to.
            point.snap = undefined;
            point.circle = undefined;
            updateSummary();
            this.onChange?.();
          });
          input.addEventListener('keydown', (e) => e.stopPropagation());
          line.append(input);
        }
        row.append(line);
      }
    }
    return row;
  }

  private draw(): void {
    // Finished measurements stay on screen with the card closed; picking only happens while it is open.
    // Numbered over the whole list, so hiding some keeps the others' numbers.
    const shown = this.all()
      .map((m, i) => ({ m, i }))
      .filter(({ m }) => !m.hidden);
    const visible = shown.length > 0 || (this.active && (this.pending !== undefined || this.hover !== undefined));
    this.svg.style.display = visible ? '' : 'none';
    this.updateReadout();
    if (!visible) return;

    const parts: string[] = [];
    shown.forEach(({ m, i }) =>
      parts.push(this.drawMeasurement(m.a, m.b, { label: m.label ?? String(i + 1), highlight: m.id === this.highlighted, code: m.fromCode })),
    );
    if (this.pending) parts.push(this.hover ? this.drawMeasurement(this.pending, this.hover, { live: true }) : this.drawEnd(this.pending));
    if (this.hover) parts.push(this.drawMarker(this.hover));
    this.svg.innerHTML = parts.join('');
  }

  private drawEnd(p: MeasurePoint): string {
    const s = this.toScreen(p.world);
    return s ? `<circle class="m-end" cx="${s.x}" cy="${s.y}" r="3"/>` : '';
  }

  private drawMeasurement(
    a: MeasurePoint,
    b: MeasurePoint,
    opts: { live?: boolean; label?: string; highlight?: boolean; code?: boolean },
  ): string {
    const sa = this.toScreen(a.world);
    const sb = this.toScreen(b.world);
    if (!sa || !sb) return '';
    const mx = (sa.x + sb.x) / 2 + 8;
    const my = (sa.y + sb.y) / 2 - 8;
    const cls = ['m-line', opts.live ? 'live' : '', opts.highlight ? 'highlight' : '', opts.code ? 'code' : ''].filter(Boolean).join(' ');
    const prefix = opts.label !== undefined ? `${escapeHtml(opts.label)}: ` : '';
    let svg =
      `<line class="${cls}" x1="${sa.x}" y1="${sa.y}" x2="${sb.x}" y2="${sb.y}"/>` +
      `<circle class="m-end" cx="${sa.x}" cy="${sa.y}" r="3"/><circle class="m-end" cx="${sb.x}" cy="${sb.y}" r="3"/>` +
      `<text class="m-label" x="${mx}" y="${my}">${prefix}${fmt(a.world.distanceTo(b.world))} mm</text>`;
    if (opts.live) svg += `<text class="m-sub" x="${mx}" y="${my + 15}">${deltaText({ a, b })}</text>`;
    return svg;
  }

  /** Cursor marker: square on a corner, ringed cross on a centre, diamond on an edge, dot when free. */
  private drawMarker(p: MeasurePoint): string {
    const s = this.toScreen(p.world);
    if (!s) return '';
    const { x, y } = s;
    switch (p.snap) {
      case 'vertex':
        return `<rect class="snap" x="${x - 5}" y="${y - 5}" width="10" height="10"/>`;
      case 'center':
        return `<circle class="snap" cx="${x}" cy="${y}" r="6"/><path class="snap" d="M${x - 9} ${y}H${x + 9}M${x} ${y - 9}V${y + 9}"/>`;
      case 'edge':
        return `<path class="snap" d="M${x} ${y - 6}L${x + 6} ${y}L${x} ${y + 6}L${x - 6} ${y}Z"/>`;
      default:
        return `<circle class="free" cx="${x}" cy="${y}" r="2.5"/>`;
    }
  }

  private updateReadout(): void {
    const p = this.hover;
    if (!this.active) return;
    if (!p) {
      this.el.readout.textContent = this.section.enabled ? 'Point at the cut…' : 'Point at the model…';
      return;
    }
    const names: Record<SnapKind, string> = { vertex: 'corner', center: 'centre', edge: 'edge' };
    const coords = `X ${fmt(p.world.x)}   Y ${fmt(p.world.y)}   Z ${fmt(p.world.z)}`;
    const snap = [p.snap ? names[p.snap] : 'free', p.circle ? `Ø ${fmt(p.circle.r * 2)}` : ''].filter(Boolean).join(' · ');
    this.el.readout.textContent = `${coords}\n${snap}`;
  }
}

/** ΔX/ΔY/ΔZ, leaving out axes the measurement doesn't move along (e.g. the plane's own axis). */
function deltaText(m: { a: MeasurePoint; b: MeasurePoint }): string {
  const d = m.b.world.clone().sub(m.a.world);
  return [0, 1, 2]
    .filter((i) => Math.abs(d.getComponent(i)) >= 0.005)
    .map((i) => `Δ${AXIS_NAMES[i]} ${fmt(Math.abs(d.getComponent(i)))}`)
    .join('  ');
}

function pointText(p: MeasurePoint): string {
  return [0, 1, 2].map((i) => `${AXIS_NAMES[i]} ${fmt(p.world.getComponent(i))}`).join('  ');
}

/** Labels come from the user's file and go into innerHTML. */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function fmt(n: number): string {
  return round(n).toFixed(2);
}

/** Two decimals, for display and for pre-filled fields; avoids showing 9.999999998. */
function round(n: number): number {
  return Math.round(n * 100) / 100;
}
