import * as THREE from 'three';

/** How far the chamfers cut into the unit cube (half-size 1): faces are squares of half-size 1 − CHAMFER. */
const CHAMFER = 0.32;
// Light grey with dark lettering, like FreeCAD's. The label texture is multiplied by these, so
// hovering tints the face and keeps the lettering.
const FACE_COLOR = 0xc9cdd3;
const BEVEL_COLOR = 0xa2a7ae;
const HOVER_COLOR = 0x7fb8ea;

/**
 * Labelled faces, Z-up like OpenSCAD (front looks from −Y). `right` and `up` orient the label as
 * seen from outside; right × up is the face's outward normal.
 */
const FACES: { label: string; normal: THREE.Vector3; right: THREE.Vector3; up: THREE.Vector3 }[] = [
  { label: 'TOP', normal: new THREE.Vector3(0, 0, 1), right: new THREE.Vector3(1, 0, 0), up: new THREE.Vector3(0, 1, 0) },
  { label: 'BOTTOM', normal: new THREE.Vector3(0, 0, -1), right: new THREE.Vector3(1, 0, 0), up: new THREE.Vector3(0, -1, 0) },
  { label: 'FRONT', normal: new THREE.Vector3(0, -1, 0), right: new THREE.Vector3(1, 0, 0), up: new THREE.Vector3(0, 0, 1) },
  { label: 'BACK', normal: new THREE.Vector3(0, 1, 0), right: new THREE.Vector3(-1, 0, 0), up: new THREE.Vector3(0, 0, 1) },
  { label: 'RIGHT', normal: new THREE.Vector3(1, 0, 0), right: new THREE.Vector3(0, 1, 0), up: new THREE.Vector3(0, 0, 1) },
  { label: 'LEFT', normal: new THREE.Vector3(-1, 0, 0), right: new THREE.Vector3(0, -1, 0), up: new THREE.Vector3(0, 0, 1) },
];

const AXES = [
  { label: 'X', dir: new THREE.Vector3(1, 0, 0), color: '#e5534b' },
  { label: 'Y', dir: new THREE.Vector3(0, 1, 0), color: '#57ab5a' },
  { label: 'Z', dir: new THREE.Vector3(0, 0, 1), color: '#539bf5' },
];

export type Corner = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';

export interface ViewCubeOptions {
  show: boolean;
  corner: Corner;
  /** The cube with its arrows, in CSS px. */
  size: number;
  axes: { show: boolean; size: number };
}

/** Width in CSS px of the ring round the cube that holds the arrows. */
const RING = 26;

export interface ViewCubeActions {
  /** Look from this direction (from the target towards the camera). */
  select(direction: THREE.Vector3): void;
  /** Turn the view in steps: left/right about the vertical, up/down over the top (degrees). */
  orbit(azimuthDeg: number, elevationDeg: number): void;
  /** Turn the view a quarter about the line of sight: 1 clockwise, −1 anticlockwise. */
  roll(direction: 1 | -1): void;
}

interface Region {
  mesh: THREE.Mesh;
  /** Where the camera looks from when this region is clicked. */
  direction: THREE.Vector3;
}

/**
 * A FreeCAD-style navigation cube in a corner of the view, turning with the camera. Its 6 faces,
 * 12 chamfered edges and 8 corner triangles each turn the view to look from that direction; arrows
 * round it (an SVG overlay) step the view by 45° or roll it by 90°. Beside it, an XYZ axes gizmo.
 */
export class ViewCube {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-2.9, 2.9, 2.9, -2.9, 0.1, 20);
  private readonly cube = new THREE.Group();
  private readonly regions: Region[] = [];
  private readonly raycaster = new THREE.Raycaster();
  private hovered?: Region;
  private readonly overlay: SVGSVGElement;
  private readonly axesScene = new THREE.Scene();
  private readonly axesCamera = new THREE.OrthographicCamera(-1.7, 1.7, 1.7, -1.7, 0.1, 10);
  private options: ViewCubeOptions = { show: true, corner: 'bottom-right', size: 190, axes: { show: true, size: 110 } };
  /** CSS px covered by overlay panels on each side; the cube keeps clear of them. */
  private insets = { left: 0, right: 0 };
  private readonly margin = 8;

  constructor(
    private readonly dom: HTMLElement,
    container: HTMLElement,
    private readonly actions: ViewCubeActions,
  ) {
    this.buildCube();
    this.buildAxes();
    this.scene.add(this.cube);
    this.overlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.overlay.id = 'view-cube-controls';
    container.append(this.overlay);
    this.configure(this.options);

    // Capture phase so a click on the cube doesn't also start an orbit drag.
    dom.addEventListener(
      'pointerdown',
      (e) => {
        const region = this.pick(e);
        if (!region) return;
        e.stopImmediatePropagation();
        e.preventDefault();
        this.actions.select(region.direction.clone());
      },
      { capture: true },
    );
    // Where the pointer rests; picked again every frame so the highlight follows the cube as it turns.
    dom.addEventListener('pointermove', (e) => {
      this.pointer = e.buttons === 0 ? { clientX: e.clientX, clientY: e.clientY } : undefined; // not while dragging the main view
    });
    dom.addEventListener('pointerleave', () => (this.pointer = undefined));
  }

  private pointer?: { clientX: number; clientY: number };

  configure(options: ViewCubeOptions): void {
    this.options = { ...options, axes: { ...options.axes } };
    // Fit the cube (about 1.75 across its corners from the centre) inside the ring of arrows.
    const pxPerUnit = (options.size / 2 - RING) / 1.75;
    const half = options.size / 2 / pxPerUnit;
    Object.assign(this.camera, { left: -half, right: half, top: half, bottom: -half });
    this.camera.updateProjectionMatrix();
    this.overlay.replaceChildren();
    this.buildOverlay();
    this.overlay.style.display = options.show ? '' : 'none';
    this.place();
  }

  setInsets(left: number, right: number): void {
    this.insets = { left, right };
    this.place();
  }

  /** CSS px boxes (from the canvas's top-left) of the cube and the axes, which sit beside it towards the middle. */
  private boxes(): { cube: { x: number; y: number }; axes: { x: number; y: number } } {
    const { width, height } = this.dom.getBoundingClientRect();
    const { corner, size, axes } = this.options;
    const right = corner.endsWith('right');
    const x = right ? width - this.insets.right - size - this.margin : this.insets.left + this.margin;
    const y = corner.startsWith('bottom') ? height - size - this.margin : this.margin;
    return {
      cube: { x, y },
      axes: { x: right ? x - axes.size : x + size, y: y + (size - axes.size) / 2 },
    };
  }

  /** Move the arrows overlay over the cube's box. */
  private place(): void {
    const { cube } = this.boxes();
    this.overlay.style.left = `${cube.x}px`;
    this.overlay.style.top = `${cube.y}px`;
  }

  /** Draw the cube and the axes into their corner, after the main scene has been drawn. */
  render(renderer: THREE.WebGLRenderer, mainCamera: THREE.Camera, width: number, height: number): void {
    const { show, size, axes } = this.options;
    if (!show && !axes.show) return;
    // Same orientation as the main camera, looking at the centre from a fixed distance.
    for (const [camera, distance] of [[this.camera, 8], [this.axesCamera, 4]] as const) {
      camera.quaternion.copy(mainCamera.quaternion);
      camera.position.set(0, 0, distance).applyQuaternion(mainCamera.quaternion);
      camera.updateMatrixWorld();
    }
    this.setHovered(this.pointer && this.pick(this.pointer));
    const boxes = this.boxes();
    this.place(); // the canvas may have been resized
    // WebGL counts y from the bottom.
    const draw = (scene: THREE.Scene, camera: THREE.Camera, box: { x: number; y: number }, s: number) => {
      const y = height - box.y - s;
      renderer.setScissor(box.x, y, s, s);
      renderer.setViewport(box.x, y, s, s);
      renderer.clearDepth();
      renderer.render(scene, camera);
    };
    renderer.setScissorTest(true);
    if (show) draw(this.scene, this.camera, boxes.cube, size);
    if (axes.show) draw(this.axesScene, this.axesCamera, boxes.axes, axes.size);
    renderer.setScissorTest(false);
    void width;
  }

  /** The 26 regions of a chamfered cube, each its own mesh so it can light up and be picked. */
  private buildCube(): void {
    const h = 1 - CHAMFER;
    const axis = (i: number, s: number) => new THREE.Vector3().setComponent(i, s);
    const outline = new THREE.LineBasicMaterial({ color: 0x2b2e33 });

    // `uvs` only for the faces, whose corners are listed counter-clockwise from outside already.
    const add = (points: THREE.Vector3[], direction: THREE.Vector3, material: THREE.MeshBasicMaterial, uvs?: number[]) => {
      // Wind the edge and corner polygons to face outward, whatever order their points came in.
      const normal = new THREE.Vector3().subVectors(points[1], points[0]).cross(new THREE.Vector3().subVectors(points[2], points[0]));
      if (normal.dot(direction) < 0) points.reverse();
      // A fan from the first point: fine for these convex polygons.
      const positions: number[] = [];
      const fanUv: number[] = [];
      for (let i = 1; i + 1 < points.length; i++) {
        for (const k of [0, i, i + 1]) {
          positions.push(...points[k].toArray());
          if (uvs) fanUv.push(uvs[k * 2], uvs[k * 2 + 1]);
        }
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      if (uvs) geometry.setAttribute('uv', new THREE.Float32BufferAttribute(fanUv, 2));
      const mesh = new THREE.Mesh(geometry, material);
      mesh.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points), outline));
      this.cube.add(mesh);
      this.regions.push({ mesh, direction: direction.clone().normalize() });
    };

    for (const face of FACES) {
      const corner = (a: number, b: number) => face.normal.clone().addScaledVector(face.right, a * h).addScaledVector(face.up, b * h);
      add(
        [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)],
        face.normal,
        new THREE.MeshBasicMaterial({ color: FACE_COLOR, map: labelTexture(face.label) }),
        [0, 0, 1, 0, 1, 1, 0, 1],
      );
    }
    // Edges: a strip between two faces, along the third axis.
    for (const [a, b] of [[0, 1], [0, 2], [1, 2]]) {
      const t = 3 - a - b;
      for (const sa of [-1, 1]) {
        for (const sb of [-1, 1]) {
          const onA = (st: number) => axis(a, sa).add(axis(b, sb * h)).add(axis(t, st * h));
          const onB = (st: number) => axis(a, sa * h).add(axis(b, sb)).add(axis(t, st * h));
          add([onA(-1), onA(1), onB(1), onB(-1)], axis(a, sa).add(axis(b, sb)), new THREE.MeshBasicMaterial({ color: BEVEL_COLOR }));
        }
      }
    }
    // Corners: a triangle joining the three faces' corners.
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const s = new THREE.Vector3(sx, sy, sz);
          const points = [0, 1, 2].map((i) => s.clone().multiplyScalar(h).setComponent(i, s.getComponent(i)));
          add(points, s, new THREE.MeshBasicMaterial({ color: BEVEL_COLOR }));
        }
      }
    }
  }

  /** The XYZ gizmo: arrows from the origin with coloured letters, in its own small view beside the cube. */
  private buildAxes(): void {
    for (const axis of AXES) {
      const color = new THREE.Color(axis.color);
      this.axesScene.add(new THREE.ArrowHelper(axis.dir, new THREE.Vector3(), 1, color, 0.3, 0.16));
      const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: letterTexture(axis.label, axis.color) }));
      label.position.copy(axis.dir).multiplyScalar(1.35);
      label.scale.setScalar(0.55);
      this.axesScene.add(label);
    }
  }

  /** Step arrows on the four sides and roll arrows at the top corners, drawn over the canvas. */
  private buildOverlay(): void {
    const s = this.options.size;
    const c = s / 2;
    const svg = this.overlay;
    svg.setAttribute('viewBox', `0 0 ${s} ${s}`);
    svg.style.width = svg.style.height = `${s}px`;

    const button = (d: string, title: string, run: () => void) => {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      path.setAttribute('class', 'cube-arrow');
      const tip = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      tip.textContent = title;
      path.append(tip);
      path.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        e.preventDefault();
        run();
      });
      svg.append(path);
    };

    // Triangles pointing out from each side. Up/down tilt over the top; left/right turn about the vertical.
    const tri = (angle: number) => {
      const at = (r: number, a: number) => `${c + r * Math.cos(a)} ${c + r * Math.sin(a)}`;
      const rad = (angle * Math.PI) / 180;
      return `M${at(c - 3, rad)}L${at(c - 15, rad - 0.15)}L${at(c - 15, rad + 0.15)}Z`;
    };
    button(tri(-90), 'Tilt up 45°', () => this.actions.orbit(0, 45));
    button(tri(90), 'Tilt down 45°', () => this.actions.orbit(0, -45));
    button(tri(180), 'Turn left 45°', () => this.actions.orbit(-45, 0));
    button(tri(0), 'Turn right 45°', () => this.actions.orbit(45, 0));

    // Curved arrows at the top corners: an arc band with an arrowhead, rolling the view 90°.
    const arc = (from: number, to: number) => {
      const [r1, r2] = [c - 18, c - 8];
      const p = (r: number, a: number) => `${c + r * Math.cos((a * Math.PI) / 180)} ${c + r * Math.sin((a * Math.PI) / 180)}`;
      const sweep = to > from ? 1 : 0;
      const head = to + (to > from ? 9 : -9);
      return (
        `M${p(r1, from)}A${r1} ${r1} 0 0 ${sweep} ${p(r1, to)}` +
        `L${p(r1 - 4, to)}L${p((r1 + r2) / 2, head)}L${p(r2 + 4, to)}L${p(r2, to)}` +
        `A${r2} ${r2} 0 0 ${1 - sweep} ${p(r2, from)}Z`
      );
    };
    button(arc(-118, -150), 'Roll the view 45° anticlockwise', () => this.actions.roll(-1));
    button(arc(-62, -30), 'Roll the view 45° clockwise', () => this.actions.roll(1));
  }

  /** The region under the pointer, if any. */
  private pick(e: { clientX: number; clientY: number }): Region | undefined {
    const { show, size } = this.options;
    if (!show) return undefined;
    const rect = this.dom.getBoundingClientRect();
    const { cube } = this.boxes();
    const x = e.clientX - rect.left - cube.x;
    const y = e.clientY - rect.top - cube.y;
    if (x < 0 || y < 0 || x > size || y > size) return undefined;
    const ndc = new THREE.Vector2((x / size) * 2 - 1, -((y / size) * 2 - 1));
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObjects(
      this.regions.map((r) => r.mesh),
      false,
    )[0];
    return hit && this.regions.find((r) => r.mesh === hit.object);
  }

  private setHovered(region: Region | undefined): void {
    if (region === this.hovered) return;
    const tint = (r: Region | undefined, on: boolean) => {
      if (!r) return;
      const m = r.mesh.material as THREE.MeshBasicMaterial;
      m.color.set(on ? HOVER_COLOR : m.map ? FACE_COLOR : BEVEL_COLOR);
    };
    tint(this.hovered, false);
    tint(region, true);
    this.hovered = region;
    this.dom.style.cursor = region ? 'pointer' : '';
  }
}

function letterTexture(letter: string, color: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = color;
  ctx.font = 'bold 44px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(letter, 32, 34);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Dark label on white; multiplied by the face's color, so the face color (and hover tint) shows. */
function labelTexture(text: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 128, 128);
  ctx.fillStyle = '#2a2d31';
  ctx.font = `bold ${text.length > 5 ? 22 : 28}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 64, 66);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}
