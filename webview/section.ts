import * as THREE from 'three';

export type Axis = 'x' | 'y' | 'z';

export interface SectionState {
  enabled: boolean;
  axis: Axis;
  /** Plane position along the axis, in mm. */
  offset: number;
  /** false: hide the side above `offset` (toward +axis). true: hide the side below. */
  flipped: boolean;
}

const AXIS_VECTORS: Record<Axis, THREE.Vector3> = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1),
};

/** Number of hatch stripes across the model's largest dimension. */
const HATCH_STRIPES = 40;

/** Diagonal hatching, the usual drawing convention for a cut face; it stands out against any model color. */
function hatchTexture(): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#a3adb8';
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = '#4d5661';
  ctx.lineWidth = 12;
  // One diagonal plus its wrapped copies so the tile repeats seamlessly.
  for (const shift of [-size, 0, size]) {
    ctx.beginPath();
    ctx.moveTo(shift, size);
    ctx.lineTo(shift + size, 0);
    ctx.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

/**
 * A clipping plane plus a solid "cap" where it cuts the model, using the stencil-buffer method:
 * for every pixel, count back faces minus front faces of the clipped model behind it; where that
 * count is non-zero the ray is inside the solid, so the cap is drawn there.
 * This needs a closed mesh, so it runs on the whole model rather than on each color separately.
 */
export class Section {
  /** Shared by every model material; clipping is switched on and off at the renderer. */
  readonly plane = new THREE.Plane();
  private readonly group = new THREE.Group();
  private readonly cap: THREE.Mesh;
  private readonly hatch = hatchTexture();
  private stencil?: THREE.Group;

  constructor(scene: THREE.Scene) {
    const capMaterial = new THREE.MeshStandardMaterial({
      map: this.hatch,
      roughness: 0.8,
      metalness: 0,
      side: THREE.DoubleSide,
      stencilWrite: true,
      stencilRef: 0,
      stencilFunc: THREE.NotEqualStencilFunc,
      stencilFail: THREE.ReplaceStencilOp,
      stencilZFail: THREE.ReplaceStencilOp,
      stencilZPass: THREE.ReplaceStencilOp,
    });
    this.cap = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), capMaterial);
    this.cap.renderOrder = 2; // after the model (0) and the stencil passes (1)
    this.cap.onAfterRender = (renderer) => renderer.clearStencil();
    this.group.add(this.cap);
    this.group.visible = false;
    scene.add(this.group);
  }

  /** Use a new model. `solid` holds every triangle of the model, so it is closed. */
  setSolid(solid: THREE.BufferGeometry | undefined): void {
    if (this.stencil) {
      this.group.remove(this.stencil);
      for (const child of this.stencil.children) ((child as THREE.Mesh).material as THREE.Material).dispose();
      this.stencil = undefined;
    }
    if (!solid) return;

    const common: THREE.MeshBasicMaterialParameters = {
      depthWrite: false,
      depthTest: false,
      colorWrite: false,
      stencilWrite: true,
      stencilFunc: THREE.AlwaysStencilFunc,
      clippingPlanes: [this.plane],
    };
    const back = new THREE.MeshBasicMaterial({
      ...common,
      side: THREE.BackSide,
      stencilFail: THREE.IncrementWrapStencilOp,
      stencilZFail: THREE.IncrementWrapStencilOp,
      stencilZPass: THREE.IncrementWrapStencilOp,
    });
    const front = new THREE.MeshBasicMaterial({
      ...common,
      side: THREE.FrontSide,
      stencilFail: THREE.DecrementWrapStencilOp,
      stencilZFail: THREE.DecrementWrapStencilOp,
      stencilZPass: THREE.DecrementWrapStencilOp,
    });
    this.stencil = new THREE.Group();
    for (const material of [back, front]) {
      const mesh = new THREE.Mesh(solid, material);
      mesh.renderOrder = 1;
      this.stencil.add(mesh);
    }
    this.group.add(this.stencil);
  }

  /** Move the plane and its cap. `bounds` is the model's bounding box, used to size the cap. */
  update(state: SectionState, bounds: THREE.Box3 | undefined): void {
    const axis = AXIS_VECTORS[state.axis];
    // Three.js keeps the side where normal·p + constant ≥ 0.
    if (state.flipped) this.plane.set(axis.clone(), -state.offset);
    else this.plane.set(axis.clone().negate(), state.offset);

    this.group.visible = state.enabled && bounds !== undefined;
    if (!bounds || bounds.isEmpty()) return;
    const center = bounds.getCenter(new THREE.Vector3());
    this.plane.projectPoint(center, this.cap.position);
    this.cap.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), this.plane.normal);
    const size = bounds.getSize(new THREE.Vector3());
    const capSize = size.length() * 1.5 + 1;
    this.cap.scale.setScalar(capSize);
    // Keep stripe spacing tied to the model's size, not to the (larger) cap quad.
    const period = Math.max(size.x, size.y, size.z, 1) / HATCH_STRIPES;
    this.hatch.repeat.setScalar(capSize / period);
  }
}
