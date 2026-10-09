import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { buildEdges, disposeTree } from './model';
import { Section, type SectionState } from './section';
import { ViewCube } from './viewCube';

export type ViewName = 'iso' | 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right';

/** Where the camera sits relative to the target for each standard view. OpenSCAD's "front" looks from −Y. */
const VIEW_DIRECTIONS: Record<ViewName, THREE.Vector3> = {
  iso: new THREE.Vector3(1, -1, 0.8).normalize(),
  // A hair off vertical: looking exactly along the up-axis makes the orbit controls lose their heading.
  top: new THREE.Vector3(0, -1e-4, 1).normalize(),
  bottom: new THREE.Vector3(0, -1e-4, -1).normalize(),
  front: new THREE.Vector3(0, -1, 0),
  back: new THREE.Vector3(0, 1, 0),
  left: new THREE.Vector3(-1, 0, 0),
  right: new THREE.Vector3(1, 0, 0),
};

const BACKGROUND = 0x1e1e1e;

/** Three.js scene, cameras and controls. Knows nothing about VS Code. */
export class Viewer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly perspective = new THREE.PerspectiveCamera(35, 1, 0.1, 10000);
  private readonly ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10000);
  private camera: THREE.PerspectiveCamera | THREE.OrthographicCamera = this.perspective;
  private readonly controls: OrbitControls;
  private readonly headlight = new THREE.DirectionalLight(0xffffff, 1.6);
  /** Half the visible height of the orthographic view at zoom 1, in mm. */
  private orthoHalfHeight = 50;

  private grid?: THREE.Object3D;
  private model?: THREE.Group;
  private modelBounds?: THREE.Box3;
  private edges?: THREE.Group;
  private showEdges = true;
  /** `#` and `%` parts, drawn over the model. */
  private debugParts?: THREE.Group;
  private showDebug = true;
  private readonly section: Section;
  private readonly viewCube: ViewCube;
  private sectionState: SectionState = { enabled: false, axis: 'z', offset: 0, flipped: false };

  constructor(private readonly container: HTMLElement) {
    // OpenSCAD is Z-up; make Three.js match so coordinates read the same in both.
    THREE.Object3D.DEFAULT_UP.set(0, 0, 1);
    this.perspective.up.set(0, 0, 1);
    this.ortho.up.set(0, 0, 1);

    // Stencil buffer is needed for the solid cross-section cap.
    this.renderer = new THREE.WebGLRenderer({ antialias: true, stencil: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    // Cleared by hand each frame so the view cube can be drawn on top in a second pass.
    this.renderer.autoClear = false;
    this.renderer.setClearColor(BACKGROUND);
    container.prepend(this.renderer.domElement);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x404040, 1.2));
    // Light from the viewer's position so whatever faces the camera is always lit.
    this.headlight.position.set(0.3, 0.5, 1);
    this.perspective.add(this.headlight);
    this.scene.add(this.perspective, this.ortho);
    this.section = new Section(this.scene);

    this.perspective.position.set(80, -120, 90);
    // Created before the orbit controls so its capture-phase click handler runs first.
    const viewCube = new ViewCube(this.renderer.domElement, (view) => this.setView(view));
    this.viewCube = viewCube;
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.setGrid(new THREE.Box3(new THREE.Vector3(-50, -50, 0), new THREE.Vector3(50, 50, 0)));

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => {
      this.controls.update();
      const { clientWidth: w, clientHeight: h } = this.container;
      this.renderer.setViewport(0, 0, w, h);
      this.renderer.clear();
      this.renderer.render(this.scene, this.camera);
      viewCube.render(this.renderer, this.camera, w);
      for (const callback of this.frameCallbacks) callback();
    });
  }

  private readonly frameCallbacks: (() => void)[] = [];

  /** Run after every frame is drawn, e.g. to move HTML overlays with the camera. */
  onFrame(callback: () => void): void {
    this.frameCallbacks.push(callback);
  }

  /** The nearest model surface along the ray, or undefined. */
  pickModel(raycaster: THREE.Raycaster): THREE.Intersection | undefined {
    if (!this.model) return undefined;
    return raycaster.intersectObject(this.model, true).find((hit) => hit.object instanceof THREE.Mesh);
  }

  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  get activeCamera(): THREE.Camera {
    return this.camera;
  }

  /** Replace the model. The camera only moves when `fit` is true (the first render). */
  setModel(model: THREE.Group | undefined, fit: boolean): void {
    if (this.model) {
      this.scene.remove(this.model);
      disposeTree(this.model);
    }
    if (this.edges) {
      this.scene.remove(this.edges);
      disposeTree(this.edges);
      this.edges = undefined;
    }
    this.model = model;
    this.modelBounds = model ? new THREE.Box3().setFromObject(model) : undefined;
    this.section.setSolid(model?.userData.solid as THREE.BufferGeometry | undefined);
    this.section.update(this.sectionState, this.modelBounds);
    if (!model) return;
    this.applyClipping(model);
    this.scene.add(model);
    this.updateEdges();
    this.setGrid(this.modelBounds!);
    if (fit) this.fit();
  }

  /**
   * Replace the `#` / `%` parts. They are cut by the section like the model, but aren't part of it:
   * not in its bounds, not picked by measuring, and not in the section cap.
   */
  setDebugParts(parts: THREE.Group | undefined): void {
    if (this.debugParts) {
      this.scene.remove(this.debugParts);
      disposeTree(this.debugParts);
    }
    this.debugParts = parts;
    if (!parts) return;
    this.applyClipping(parts);
    parts.visible = this.showDebug;
    this.scene.add(parts);
  }

  setDebugVisible(on: boolean): void {
    this.showDebug = on;
    if (this.debugParts) this.debugParts.visible = on;
  }

  /**
   * Overlay panels cover `left` and `right` CSS px of the canvas. The model view is untouched;
   * only the view cube and the badge/banner move clear of the panels.
   */
  setInsets(left: number, right: number): void {
    this.viewCube.rightInset = right;
    this.container.style.setProperty('--inset-left', `${left}px`);
    this.container.style.setProperty('--inset-right', `${right}px`);
  }

  /** The current model's bounding box, or undefined when there is no model. */
  get bounds(): THREE.Box3 | undefined {
    return this.modelBounds?.clone();
  }

  /** Show or move the cross-section. The state is kept across model changes. */
  setSection(state: SectionState): void {
    this.sectionState = { ...state };
    this.renderer.localClippingEnabled = state.enabled;
    this.section.update(this.sectionState, this.modelBounds);
  }

  /** Point every material under `root` at the section plane; the renderer decides whether it applies. */
  private applyClipping(root: THREE.Object3D): void {
    root.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) {
        const materials = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of materials) m.clippingPlanes = [this.section.plane];
      }
    });
  }

  fit(): void {
    if (!this.model) return;
    const box = new THREE.Box3().setFromObject(this.model);
    if (box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const direction = this.camera.position.clone().sub(this.controls.target).normalize();
    this.frame(sphere, direction.lengthSq() > 0 ? direction : VIEW_DIRECTIONS.iso);
  }

  setView(name: ViewName): void {
    const sphere = this.model
      ? new THREE.Box3().setFromObject(this.model).getBoundingSphere(new THREE.Sphere())
      : new THREE.Sphere(new THREE.Vector3(), 50);
    this.frame(sphere, VIEW_DIRECTIONS[name]);
  }

  setOrthographic(on: boolean): void {
    const from = this.camera;
    const to = on ? this.ortho : this.perspective;
    if (from === to) return;
    const target = this.controls.target;
    const direction = from.position.clone().sub(target).normalize();
    const fovHalf = THREE.MathUtils.degToRad(this.perspective.fov / 2);

    if (on) {
      // Match the visible height at the target so the switch doesn't jump.
      this.orthoHalfHeight = from.position.distanceTo(target) * Math.tan(fovHalf);
      this.ortho.zoom = 1;
      this.ortho.position.copy(from.position);
    } else {
      const distance = this.orthoHalfHeight / this.ortho.zoom / Math.tan(fovHalf);
      this.perspective.position.copy(target).addScaledVector(direction, distance);
    }
    to.near = from.near;
    to.far = from.far;
    to.add(this.headlight);
    this.camera = to;
    this.controls.object = to;
    this.resize();
  }

  setEdges(on: boolean): void {
    this.showEdges = on;
    this.updateEdges();
  }

  private updateEdges(): void {
    if (this.showEdges && this.model && !this.edges) {
      this.edges = buildEdges(this.model);
      if (this.edges) {
        this.applyClipping(this.edges);
        this.scene.add(this.edges);
      }
    }
    if (this.edges) this.edges.visible = this.showEdges;
  }

  /** Point the camera at `sphere` from `direction`, close enough to fill the view. */
  private frame(sphere: THREE.Sphere, direction: THREE.Vector3): void {
    const radius = Math.max(sphere.radius, 1);
    const fovHalf = THREE.MathUtils.degToRad(this.perspective.fov / 2);
    const aspect = this.perspective.aspect;
    // Fit whichever of the vertical or horizontal field of view is tighter.
    const fitHalf = aspect < 1 ? Math.atan(Math.tan(fovHalf) * aspect) : fovHalf;
    const distance = (radius / Math.sin(fitHalf)) * 1.05;

    this.controls.target.copy(sphere.center);
    for (const cam of [this.perspective, this.ortho]) {
      cam.position.copy(sphere.center).addScaledVector(direction, distance);
      cam.near = distance / 100;
      cam.far = distance * 100;
    }
    this.orthoHalfHeight = (radius * 1.05) / Math.min(aspect, 1);
    this.ortho.zoom = 1;
    this.resize();
    this.controls.update();
  }

  /** A 10 mm grid on the build plate (100 mm for big models), sized to cover the model. */
  private setGrid(box: THREE.Box3): void {
    if (this.grid) {
      this.scene.remove(this.grid);
      disposeTree(this.grid);
    }
    const extent = Math.max(Math.abs(box.min.x), Math.abs(box.max.x), Math.abs(box.min.y), Math.abs(box.max.y), 10);
    const spacing = extent > 250 ? 100 : 10;
    const size = Math.ceil((extent * 1.2) / spacing) * spacing * 2;
    const grid = new THREE.GridHelper(size, size / spacing, 0x555555, 0x333333);
    grid.rotation.x = Math.PI / 2; // GridHelper lies in XZ; rotate into the XY build plate.
    this.grid = grid;
    this.scene.add(grid);
  }

  private resize(): void {
    const { clientWidth: w, clientHeight: h } = this.container;
    this.renderer.setSize(w, h);
    const aspect = w / Math.max(h, 1);
    this.perspective.aspect = aspect;
    this.perspective.updateProjectionMatrix();
    this.ortho.left = -this.orthoHalfHeight * aspect;
    this.ortho.right = this.orthoHalfHeight * aspect;
    this.ortho.top = this.orthoHalfHeight;
    this.ortho.bottom = -this.orthoHalfHeight;
    this.ortho.updateProjectionMatrix();
  }
}
