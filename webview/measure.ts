import * as THREE from 'three';
import type { CodeMeasure, MeasureKind, SavedMeasurement, SavedMeasures } from '../src/sharedTypes';
import { castRay, type Vec3 } from './meshRay';
import type { SectionState } from './section';
import {
  findSnap,
  loopAround,
  PLANE_AXES,
  pointsBounds,
  sliceMesh,
  wallAcross,
  type AxisIndex,
  type Circle,
  type Slice,
  type SnapKind,
} from './slice';
import type { Viewer } from './viewer';

const AXIS_INDEX: Record<SectionState['axis'], AxisIndex> = { x: 0, y: 1, z: 2 };
const AXIS_NAMES = 'XYZ';
/** Snap when a feature is within this many screen pixels of the cursor. */
const SNAP_PX = 10;
/** A press that moves less than this is a click; more is an orbit drag. */
const CLICK_SLOP_PX = 4;

/** Tools that collect clicked or typed points one at a time; wall and box take one click. */
type PointTool = 'distance' | 'angle';
const ENTRY_LABELS: Record<PointTool, string[]> = {
  distance: ['First point', 'Second point'],
  angle: ['First arm', 'Corner', 'Second arm'],
};
/** What each point is called in a list row's edit fields. */
const POINT_NAMES: Record<MeasureKind, string[]> = {
  distance: ['A', 'B'],
  wall: ['A', 'B'],
  angle: ['A', 'V', 'B'],
  box: ['Min', 'Max'],
};
/** One line under the tool buttons; the buttons' tooltips say more. */
const HINTS: Record<MeasureKind, string> = {
  distance: 'Click two points. Alt: no snapping. Esc: cancel.',
  wall: 'Click an edge of the cut, or the surface.',
  angle: 'Click an arm, the corner, then the other arm.',
  box: 'Click an outline or hole; away from them for all.',
};
const KIND_NAMES: Record<MeasureKind, string> = { distance: 'Distance', wall: 'Wall thickness', angle: 'Angle', box: 'Size' };
/** 12 px line icons for the list, so each row's kind shows at a glance. */
const KIND_ICONS: Record<MeasureKind, string> = {
  distance: '<path d="M2.5 6h7"/><circle class="dot" cx="2" cy="6" r="1.6"/><circle class="dot" cx="10" cy="6" r="1.6"/>',
  wall: '<path d="M1.5 6h9M1.5 3v6M10.5 3v6"/>',
  angle: '<path d="M1.5 10.5h9M1.5 10.5 8 2.5M5 10.5a3.5 3.5 0 0 0-1-2.6"/>',
  box: '<rect x="1.5" y="2.5" width="9" height="7"/>',
};

interface MeasurePoint {
  world: THREE.Vector3;
  /** What it snapped to; undefined for a free point. */
  snap?: SnapKind;
  /** The circle it snapped to or onto, for showing a diameter. */
  circle?: Circle;
}

/**
 * The geometry of a measurement.
 * - distance, wall: points[0] to points[1].
 * - angle: at points[1], between points[0] and points[2].
 * - box: points[0] is the low corner and points[1] the high one.
 */
interface Shape {
  kind: MeasureKind;
  points: MeasurePoint[];
  /** Box of a round outline. */
  diameter?: number;
}

interface Measurement extends Shape {
  id: number;
  /** Set for measurements from `echo("measure", …)`; these are owned by the file, not the list. */
  fromCode?: boolean;
  label?: string;
  /** Listed but not drawn. */
  hidden?: boolean;
}

/** What a one-click tool would do at the cursor: a marker to show, and the shape a click adds. */
interface OneClick {
  marker?: MeasurePoint;
  shape?: Shape;
}

export interface MeasureElements {
  /** Toolbar button that opens and closes the card. Clicks on the model add points only while it is open. */
  toggle: HTMLButtonElement;
  /** Floating card holding everything below. */
  card: HTMLElement;
  /** Row of buttons with `data-tool` set to a MeasureKind. */
  tools: HTMLElement;
  readout: HTMLElement;
  hint: HTMLElement;
  list: HTMLElement;
  clearAll: HTMLButtonElement;
  /** Row above the list with the show-all checkbox and Clear; shown only when something is listed. */
  listHead: HTMLElement;
  allToggle: HTMLInputElement;
  /** Manual point entry, shown for the tools that take points one at a time. */
  entry: {
    box: HTMLElement;
    label: HTMLElement;
    x: HTMLInputElement;
    y: HTMLInputElement;
    z: HTMLInputElement;
    relative: HTMLInputElement;
    add: HTMLButtonElement;
  };
}

/**
 * Measuring tools: distance, wall thickness, angle and bounding box.
 * - Section on: clicks land on the cut plane (never a surface behind it) and snap to the cut outline.
 * - Section off: clicks land on the model surface and snap to a nearby mesh corner.
 * Snapping only happens near a feature; Alt turns it off. Results are listed in the card and drawn
 * in an SVG overlay that follows the camera.
 */
export class Measure {
  private active = false;
  private tool: MeasureKind = 'distance';
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
  /** Points of the distance or angle being picked. */
  private pending: MeasurePoint[] = [];
  private hover?: MeasurePoint;
  /** What a click would add with a one-click tool (wall, box). */
  private preview?: Shape;
  private highlighted?: number;
  /** Measurement whose name and points are open for editing in the list. */
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
    for (const button of el.tools.querySelectorAll<HTMLButtonElement>('button[data-tool]')) {
      button.addEventListener('click', () => this.setTool(button.dataset.tool as MeasureKind));
    }
    el.clearAll.addEventListener('click', () => {
      this.measurements = [];
      this.clearPending();
      this.renderList();
      this.onChange?.();
    });
    el.allToggle.addEventListener('change', () => this.setHidden(this.all(), !el.allToggle.checked));

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
      const cursor = this.aim(e);
      if (this.isOneClick()) {
        const { shape } = this.oneClick(e.altKey);
        if (shape) this.addMeasurement(shape);
      } else {
        const point = this.pointAt(e.altKey, cursor);
        if (point) this.addPoint(point);
      }
    });
    canvas.addEventListener('pointermove', (e) => {
      this.hover = undefined;
      this.preview = undefined;
      if (!this.active || e.buttons !== 0) return;
      const cursor = this.aim(e);
      if (this.isOneClick()) {
        const { marker, shape } = this.oneClick(e.altKey);
        this.hover = marker;
        this.preview = shape;
      } else {
        this.hover = this.pointAt(e.altKey, cursor);
      }
    });
    canvas.addEventListener('pointerleave', () => {
      this.hover = undefined;
      this.preview = undefined;
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.clearPending();
    });

    viewer.onFrame(() => this.draw());
    this.setActive(false);
    this.setTool('distance');
    this.renderList();
  }

  private isOneClick(): boolean {
    return this.tool === 'wall' || this.tool === 'box';
  }

  setTool(tool: MeasureKind): void {
    this.tool = tool;
    this.hover = undefined;
    this.preview = undefined;
    for (const button of this.el.tools.querySelectorAll<HTMLButtonElement>('button[data-tool]')) {
      button.classList.toggle('on', button.dataset.tool === tool);
    }
    this.el.hint.textContent = HINTS[tool];
    this.clearPending();
  }

  /** A clicked or typed point: adds to the distance or angle in progress, finishing it when complete. */
  private addPoint(point: MeasurePoint): void {
    const tool = this.tool as PointTool;
    this.pending.push(point);
    if (this.pending.length === ENTRY_LABELS[tool].length) {
      const points = this.pending;
      this.pending = [];
      this.addMeasurement({ kind: tool, points });
    }
    this.syncEntry();
  }

  private addMeasurement(shape: Shape): void {
    this.measurements.push({ id: this.nextId++, ...shape });
    this.renderList();
    this.onChange?.();
  }

  private clearPending(): void {
    this.pending = [];
    this.syncEntry();
  }

  /** What to save: the user's measurements (code ones come from the file) and which code ones are hidden. */
  getSaved(): SavedMeasures {
    const vec = (p: MeasurePoint): Vec3 => [p.world.x, p.world.y, p.world.z];
    return {
      measurements: this.measurements.map((m) => {
        const saved: SavedMeasurement = { a: vec(m.points[0]), b: vec(m.points[1]) };
        if (m.kind !== 'distance') saved.kind = m.kind;
        if (m.points[2]) saved.c = vec(m.points[2]);
        if (m.diameter !== undefined) saved.diameter = m.diameter;
        if (m.label) saved.label = m.label;
        if (m.hidden) saved.hidden = true;
        return saved;
      }),
      hiddenCode: [...this.hiddenCode],
    };
  }

  /** Replace the user's measurements with saved ones. */
  load(saved: SavedMeasures): void {
    const point = (v: Vec3): MeasurePoint => ({ world: new THREE.Vector3(...v) });
    this.measurements = saved.measurements.map((m) => ({
      id: this.nextId++,
      kind: m.kind ?? 'distance',
      points: [m.a, m.b, ...(m.c ? [m.c] : [])].map(point),
      diameter: m.diameter,
      label: m.label,
      hidden: m.hidden,
    }));
    this.hiddenCode.clear();
    for (const key of saved.hiddenCode) this.hiddenCode.add(key);
    for (const m of this.codeMeasurements) m.hidden = this.hiddenCode.has(this.codeKey(m));
    this.renderList();
    if (this.pending.length === 0) this.syncEntry();
  }

  /** Point from the X/Y/Z fields; with "relative", an offset from the previous point. */
  private addFromEntry(): void {
    if (this.isOneClick()) return;
    const { x, y, z, relative } = this.el.entry;
    const previous = this.pending.at(-1);
    const offset = relative.checked && previous !== undefined;
    const base = offset ? previous!.world : new THREE.Vector3();
    const values = [x, y, z].map((input, i) => {
      const n = Number(input.value);
      return input.value.trim() !== '' && Number.isFinite(n) ? n : offset ? 0 : base.getComponent(i);
    });
    const world = new THREE.Vector3(...values);
    if (offset) world.add(base);
    this.addPoint({ world });
  }

  /** Show the entry for point tools, labelled and pre-filled for the next point. */
  private syncEntry(): void {
    const { box, label, x, y, z, relative } = this.el.entry;
    box.hidden = this.isOneClick();
    if (this.isOneClick()) return;
    const previous = this.pending.at(-1);
    label.textContent = ENTRY_LABELS[this.tool as PointTool][this.pending.length];
    relative.disabled = !previous;
    if (!previous) relative.checked = false;
    let fill: THREE.Vector3;
    if (relative.checked) {
      fill = new THREE.Vector3();
    } else {
      // Start from the last point used, so typically only one value needs changing.
      fill = previous?.world.clone() ?? this.measurements.at(-1)?.points.at(-1)?.world.clone() ?? new THREE.Vector3();
      if (!previous && this.section.enabled) fill.setComponent(AXIS_INDEX[this.section.axis], this.section.offset);
    }
    [x, y, z].forEach((input, i) => (input.value = String(round(fill.getComponent(i)))));
  }

  setActive(active: boolean): void {
    this.active = active;
    if (!active) {
      this.clearPending();
      this.hover = undefined;
      this.preview = undefined;
    }
    this.el.toggle.classList.toggle('on', active);
    this.el.card.hidden = !active;
    this.viewer.canvas.classList.toggle('measuring', active);
  }

  setSection(state: SectionState): void {
    this.section = { ...state };
    if (this.pending.length === 0) this.syncEntry();
  }

  /** Measurements the model echoed; they replace the previous render's. */
  setCodeMeasures(measures: CodeMeasure[]): void {
    this.codeMeasurements = measures.map((m) => ({
      id: this.nextId++,
      kind: 'distance',
      points: [{ world: new THREE.Vector3(...m.a) }, { world: new THREE.Vector3(...m.b) }],
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

  /** The world point at plane coordinates (u, v) on the section plane. */
  private onPlane(pu: number, pv: number): THREE.Vector3 {
    const { axis, u, v } = this.planeAxes();
    return new THREE.Vector3().setComponent(axis, this.section.offset).setComponent(u, pu).setComponent(v, pv);
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

  /** Point the raycaster through the cursor; returns the cursor's canvas position. */
  private aim(e: PointerEvent): { x: number; y: number } {
    const rect = this.viewer.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    // The camera may have moved since the last frame (e.g. a view button just clicked).
    this.viewer.activeCamera.updateMatrixWorld();
    this.raycaster.setFromCamera(ndc, this.viewer.activeCamera);
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private pointAt(free: boolean, cursor: { x: number; y: number }): MeasurePoint | undefined {
    return this.section.enabled ? this.pointOnSection(free) : this.pointOnSurface(free, cursor);
  }

  private planeHit(): THREE.Vector3 | undefined {
    const normal = new THREE.Vector3().setComponent(this.planeAxes().axis, 1);
    return this.raycaster.ray.intersectPlane(new THREE.Plane(normal, -this.section.offset), new THREE.Vector3()) ?? undefined;
  }

  /** SNAP_PX converted to mm at a point on the plane, at the current zoom. */
  private snapRadius(hit: THREE.Vector3): number | undefined {
    const { u } = this.planeAxes();
    const here = this.toScreen(hit);
    const along = this.toScreen(hit.clone().setComponent(u, hit.getComponent(u) + 1));
    const pxPerMm = here && along ? Math.hypot(along.x - here.x, along.y - here.y) : 0;
    return pxPerMm > 0 ? SNAP_PX / pxPerMm : undefined;
  }

  /** Section on: the ray meets the cut plane, then snaps to the cut outline. */
  private pointOnSection(free: boolean): MeasurePoint | undefined {
    const hit = this.planeHit();
    if (!hit) return undefined;
    const slice = free ? undefined : this.currentSlice();
    const radius = slice && this.snapRadius(hit);
    if (!slice || !radius) return { world: hit };
    const { u, v } = this.planeAxes();
    const snap = findSnap(slice, hit.getComponent(u), hit.getComponent(v), radius);
    if (!snap) return { world: hit };
    return { world: this.onPlane(snap.u, snap.v), snap: snap.kind, circle: snap.loop.circle };
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

  /** Wall or box at the cursor (the raycaster must already be aimed). */
  private oneClick(free: boolean): OneClick {
    if (this.tool === 'wall') return this.section.enabled ? this.wallOnSection() : this.wallOnSurface();
    return this.section.enabled ? this.boxOnSection(free) : this.boxOfModel();
  }

  /** From the cut edge nearest the cursor, straight across the material. */
  private wallOnSection(): OneClick {
    const hit = this.planeHit();
    if (!hit) return {};
    const slice = this.currentSlice();
    const radius = this.snapRadius(hit);
    const { u, v } = this.planeAxes();
    const wall = slice && radius ? wallAcross(slice, hit.getComponent(u), hit.getComponent(v), radius) : undefined;
    if (!wall) return { marker: { world: hit } };
    const from = this.onPlane(...wall.from);
    return {
      marker: { world: from, snap: 'edge' },
      shape: { kind: 'wall', points: [{ world: from }, { world: this.onPlane(...wall.to) }] },
    };
  }

  /** From the surface point, along the inward normal until the ray leaves the material. */
  private wallOnSurface(): OneClick {
    const hit = this.viewer.pickModel(this.raycaster);
    if (!hit) return {};
    const marker: MeasurePoint = { world: hit.point.clone() };
    if (!hit.face || !this.positions) return { marker };
    const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
    // Outward means toward the camera; a two-sided material can report the back face's normal.
    if (normal.dot(this.raycaster.ray.direction) > 0) normal.negate();
    const inward = normal.negate();
    const t = castRay(this.positions, hit.point.toArray() as Vec3, inward.toArray() as Vec3, 1e-4);
    if (t === undefined) return { marker };
    return {
      marker,
      shape: { kind: 'wall', points: [{ world: hit.point.clone() }, { world: hit.point.clone().addScaledVector(inward, t) }] },
    };
  }

  /** The outline under the cursor (a hole, or the part around it); the whole cut away from them. */
  private boxOnSection(free: boolean): OneClick {
    const hit = this.planeHit();
    const slice = this.currentSlice();
    if (!hit) return {};
    if (!slice || slice.loops.length === 0) return { marker: { world: hit } };
    const { u, v } = this.planeAxes();
    const [hu, hv] = [hit.getComponent(u), hit.getComponent(v)];
    const radius = free ? undefined : this.snapRadius(hit);
    const loop = (radius ? findSnap(slice, hu, hv, radius)?.loop : undefined) ?? loopAround(slice, hu, hv);
    const b = pointsBounds(loop ? loop.points : slice.loops.flatMap((l) => l.points));
    const shape: Shape = { kind: 'box', points: [{ world: this.onPlane(b.minU, b.minV) }, { world: this.onPlane(b.maxU, b.maxV) }] };
    if (loop?.circle) shape.diameter = loop.circle.r * 2;
    return { marker: { world: hit }, shape };
  }

  private boxOfModel(): OneClick {
    const hit = this.viewer.pickModel(this.raycaster);
    const bounds = this.viewer.bounds;
    if (!hit || !bounds) return {};
    return {
      marker: { world: hit.point.clone() },
      shape: { kind: 'box', points: [{ world: bounds.min }, { world: bounds.max }] },
    };
  }

  private renderList(): void {
    const all = this.all();
    const rows = all.map((m, i) => this.buildRow(m, i + 1));
    if (rows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'measure-empty';
      empty.innerHTML = 'No measurements yet. The model can add its own with <code>echo("measure", [x,y,z], [x,y,z], "label");</code>';
      rows.push(empty);
    }
    this.el.list.replaceChildren(...rows);
    this.el.clearAll.disabled = this.measurements.length === 0;
    this.el.listHead.hidden = all.length === 0;
    // Ticked when all are shown, a dash when some are.
    const hiddenCount = all.filter((m) => m.hidden).length;
    this.el.allToggle.checked = hiddenCount === 0;
    this.el.allToggle.indeterminate = hiddenCount > 0 && hiddenCount < all.length;
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

  /** One list entry: a summary line (click to open the name and points for editing) and a remove button. */
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
    // One aligned line: show, kind icon, number and name, value, then remove (or the code tag).
    const icon = document.createElement('span');
    icon.className = 'kind';
    icon.title = KIND_NAMES[m.kind];
    icon.innerHTML = `<svg viewBox="0 0 12 12">${KIND_ICONS[m.kind]}</svg>`;
    const num = document.createElement('b');
    num.className = 'num';
    num.textContent = `${number}.`;
    const name = document.createElement('span');
    name.className = 'name';
    const value = document.createElement('span');
    value.className = 'value';
    const detail = document.createElement('div');
    detail.className = 'deltas';
    const updateSummary = () => {
      name.textContent = m.label ?? '';
      name.title = m.label ?? '';
      value.textContent = valueText(m, true);
      value.title = sizeText(m);
      detail.textContent = detailText(m);
      detail.hidden = !detail.textContent;
    };
    updateSummary();
    if (m.fromCode) {
      // The file decides these points, so they are changed by editing the file, not here.
      row.classList.add('code');
      head.title = `From echo("measure", …) in the file\nA ${pointText(m.points[0])}\nB ${pointText(m.points[1])}`;
      const tag = document.createElement('span');
      tag.className = 'code-tag';
      tag.textContent = 'code';
      head.append(show, icon, num, name, value, tag);
      row.append(head, detail);
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
    head.append(show, icon, num, name, value, remove);
    row.append(head, detail);

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

      POINT_NAMES[m.kind].forEach((name, p) => {
        const point = m.points[p];
        const line = document.createElement('div');
        line.className = 'xyz';
        const label = document.createElement('span');
        label.className = 'point-name';
        label.textContent = name;
        if (name === 'V') label.title = 'Corner (vertex) of the angle';
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
            m.diameter = undefined;
            updateSummary();
            this.onChange?.();
          });
          input.addEventListener('keydown', (e) => e.stopPropagation());
          line.append(input);
        }
        row.append(line);
      });
    }
    return row;
  }

  private draw(): void {
    // Finished measurements stay on screen with the card closed; picking only happens while it is open.
    // Numbered over the whole list, so hiding some keeps the others' numbers.
    const shown = this.all()
      .map((m, i) => ({ m, i }))
      .filter(({ m }) => !m.hidden);
    const picking = this.active && (this.pending.length > 0 || this.hover !== undefined || this.preview !== undefined);
    const visible = shown.length > 0 || picking;
    this.svg.style.display = visible ? '' : 'none';
    this.updateReadout();
    if (!visible) return;

    const parts: string[] = [];
    shown.forEach(({ m, i }) =>
      parts.push(this.drawShape(m, { label: m.label ?? String(i + 1), highlight: m.id === this.highlighted, code: m.fromCode })),
    );
    if (this.preview) {
      parts.push(this.drawShape(this.preview, { live: true }));
    } else if (this.pending.length > 0) {
      // The distance or angle so far, with the cursor as its next point.
      const live = this.hover ? [...this.pending, this.hover] : this.pending;
      if (live.length === 1) parts.push(this.drawEnd(live[0]));
      else parts.push(this.drawShape({ kind: live.length === 3 ? 'angle' : 'distance', points: live }, { live: true }));
    }
    if (this.hover) parts.push(this.drawMarker(this.hover));
    this.svg.innerHTML = parts.join('');
  }

  private drawEnd(p: MeasurePoint): string {
    const s = this.toScreen(p.world);
    return s ? `<circle class="m-end" cx="${s.x}" cy="${s.y}" r="3"/>` : '';
  }

  private drawShape(shape: Shape, opts: { live?: boolean; label?: string; highlight?: boolean; code?: boolean }): string {
    const cls = ['m-line', opts.live ? 'live' : '', opts.highlight ? 'highlight' : '', opts.code ? 'code' : ''].filter(Boolean).join(' ');
    const text = `${opts.label !== undefined ? `${escapeHtml(opts.label)}: ` : ''}${valueText(shape)}`;
    const line = (a: { x: number; y: number }, b: { x: number; y: number }) =>
      `<line class="${cls}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/>`;
    const end = (s: { x: number; y: number }) => `<circle class="m-end" cx="${s.x}" cy="${s.y}" r="3"/>`;

    if (shape.kind === 'box') {
      const [lo, hi] = shape.points.map((p) => p.world);
      const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((bits) =>
        this.toScreen(new THREE.Vector3(bits & 1 ? hi.x : lo.x, bits & 2 ? hi.y : lo.y, bits & 4 ? hi.z : lo.z)),
      );
      if (corners.some((c) => !c)) return '';
      const s = corners as { x: number; y: number }[];
      let svg = '';
      // Corners joined when they differ along exactly one axis: the 12 edges.
      for (let a = 0; a < 8; a++) for (const bit of [1, 2, 4]) if (!(a & bit)) svg += line(s[a], s[a | bit]);
      const top = s.reduce((best, c) => (c.y < best.y ? c : best));
      return `${svg}<text class="m-label" x="${top.x + 6}" y="${top.y - 6}">${text}</text>`;
    }

    if (shape.kind === 'angle') {
      const pts = shape.points.map((p) => this.toScreen(p.world));
      if (pts.some((p) => !p)) return '';
      const [sa, sv, sc] = pts as { x: number; y: number }[];
      const a1 = Math.atan2(sa.y - sv.y, sa.x - sv.x);
      let sweep = Math.atan2(sc.y - sv.y, sc.x - sv.x) - a1;
      if (sweep > Math.PI) sweep -= 2 * Math.PI;
      if (sweep <= -Math.PI) sweep += 2 * Math.PI;
      const r = 18;
      const at = (angle: number, dist: number) => ({ x: sv.x + dist * Math.cos(angle), y: sv.y + dist * Math.sin(angle) });
      const [from, to] = [at(a1, r), at(a1 + sweep, r)];
      const labelAt = at(a1 + sweep / 2, r + 16);
      return (
        line(sv, sa) +
        line(sv, sc) +
        `<path class="${cls}" fill="none" d="M${from.x} ${from.y}A${r} ${r} 0 0 ${sweep > 0 ? 1 : 0} ${to.x} ${to.y}"/>` +
        end(sa) +
        end(sv) +
        end(sc) +
        `<text class="m-label" x="${labelAt.x}" y="${labelAt.y}" text-anchor="middle">${text}</text>`
      );
    }

    // distance, wall
    const [a, b] = shape.points;
    const sa = this.toScreen(a.world);
    const sb = this.toScreen(b.world);
    if (!sa || !sb) return '';
    const mx = (sa.x + sb.x) / 2 + 8;
    const my = (sa.y + sb.y) / 2 - 8;
    let svg = line(sa, sb) + end(sa) + end(sb) + `<text class="m-label" x="${mx}" y="${my}">${text}</text>`;
    if (opts.live) svg += `<text class="m-sub" x="${mx}" y="${my + 15}">${deltaText(a, b)}</text>`;
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
    if (!this.active) return;
    const p = this.hover;
    if (!p) {
      const where = !this.section.enabled ? 'the model' : this.tool === 'wall' ? 'an edge of the cut' : 'the cut';
      this.el.readout.textContent = `Point at ${where}…`;
      return;
    }
    const coords = `X ${fmt(p.world.x)}   Y ${fmt(p.world.y)}   Z ${fmt(p.world.z)}`;
    let second: string;
    if (this.isOneClick()) {
      second = this.preview ? `${this.tool} ${valueText(this.preview)}` : this.tool === 'wall' ? 'no wall here' : 'nothing to box here';
    } else {
      const names: Record<SnapKind, string> = { vertex: 'corner', center: 'centre', edge: 'edge' };
      second = [p.snap ? names[p.snap] : 'free', p.circle ? `Ø ${fmt(p.circle.r * 2)}` : ''].filter(Boolean).join(' · ');
    }
    this.el.readout.textContent = `${coords}\n${second}`;
  }
}

/** The headline number: a length, an angle, or a box's size. `compact` fits a box's three sizes in a list row. */
function valueText(shape: Shape, compact = false): string {
  const [a, b, c] = shape.points.map((p) => p.world);
  switch (shape.kind) {
    case 'angle':
      return `${fmt(THREE.MathUtils.radToDeg(a.clone().sub(b).angleTo(c.clone().sub(b))))}°`;
    case 'box': {
      if (shape.diameter !== undefined) return `Ø ${fmt(shape.diameter)} mm`;
      const sizes = [0, 1, 2].map((i) => Math.abs(b.getComponent(i) - a.getComponent(i))).filter((s) => s >= 0.005);
      if (!sizes.length) return `${fmt(0)} mm`;
      return compact ? sizes.map(fmt).join(' × ') : `${sizes.map(fmt).join(' × ')} mm`;
    }
    default:
      return `${fmt(a.distanceTo(b))} mm`;
  }
}

/** The small line under a list row: per-axis steps for lengths that aren't along one axis. */
function detailText(shape: Shape): string {
  if (shape.kind !== 'distance' && shape.kind !== 'wall') return '';
  const [a, b] = shape.points;
  const d = b.world.clone().sub(a.world);
  // Along a single axis the value already says it all.
  const axes = [0, 1, 2].filter((i) => Math.abs(d.getComponent(i)) >= 0.005).length;
  return axes > 1 ? deltaText(a, b) : '';
}

/** A box's size per axis, for the value's tooltip. */
function sizeText(shape: Shape): string {
  if (shape.kind !== 'box') return '';
  const [a, b] = shape.points.map((p) => p.world);
  return [0, 1, 2]
    .map((i) => ({ i, size: Math.abs(b.getComponent(i) - a.getComponent(i)) }))
    .filter(({ size }) => size >= 0.005)
    .map(({ i, size }) => `${AXIS_NAMES[i]} ${fmt(size)} mm`)
    .join('\n');
}

/** ΔX/ΔY/ΔZ, leaving out axes the measurement doesn't move along (e.g. the plane's own axis). */
function deltaText(a: MeasurePoint, b: MeasurePoint): string {
  const d = b.world.clone().sub(a.world);
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
