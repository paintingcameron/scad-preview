import * as THREE from 'three';
import type { ViewName } from './viewer';

/**
 * Face order of THREE.BoxGeometry is +X, −X, +Y, −Y, +Z, −Z. The cube is built Y-up and turned
 * 90° about X to match OpenSCAD's Z-up, which maps those faces to the views below.
 */
const FACES: { label: string; view: ViewName }[] = [
  { label: 'Right', view: 'right' },
  { label: 'Left', view: 'left' },
  { label: 'Top', view: 'top' },
  { label: 'Bottom', view: 'bottom' },
  { label: 'Front', view: 'front' },
  { label: 'Back', view: 'back' },
];

const HOVER_TINT = 0x9fd4ff;

const AXES = [
  { label: 'X', dir: new THREE.Vector3(1, 0, 0), color: '#e5534b' },
  { label: 'Y', dir: new THREE.Vector3(0, 1, 0), color: '#57ab5a' },
  { label: 'Z', dir: new THREE.Vector3(0, 0, 1), color: '#539bf5' },
];

/** A small labelled cube in the bottom-right corner that turns with the camera. Click a face to look at it. */
export class ViewCube {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1.8, 1.8, 1.8, -1.8, 0.1, 10);
  private readonly cube: THREE.Mesh;
  private readonly materials: THREE.MeshBasicMaterial[];
  private readonly raycaster = new THREE.Raycaster();
  private hovered = -1;
  /** Width in CSS px covered by an overlay panel on the right; the cube sits left of it. */
  rightInset = 0;
  /** XYZ arrows drawn in their own small viewport to the left of the cube. */
  private readonly axesScene = new THREE.Scene();
  private readonly axesCamera = new THREE.OrthographicCamera(-1.7, 1.7, 1.7, -1.7, 0.1, 10);

  constructor(
    private readonly dom: HTMLElement,
    private readonly onSelect: (view: ViewName) => void,
    private readonly size = 96,
    private readonly margin = 10,
    private readonly axesSize = 96,
  ) {
    for (const axis of AXES) {
      const color = new THREE.Color(axis.color);
      this.axesScene.add(new THREE.ArrowHelper(axis.dir, new THREE.Vector3(), 1, color, 0.3, 0.16));
      const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: letterTexture(axis.label, axis.color) }));
      label.position.copy(axis.dir).multiplyScalar(1.35);
      label.scale.setScalar(0.55);
      this.axesScene.add(label);
    }

    this.materials = FACES.map((f) => new THREE.MeshBasicMaterial({ map: labelTexture(f.label) }));
    const geometry = new THREE.BoxGeometry(2, 2, 2);
    this.cube = new THREE.Mesh(geometry, this.materials);
    this.cube.rotation.x = Math.PI / 2;
    this.cube.add(
      new THREE.LineSegments(new THREE.EdgesGeometry(geometry), new THREE.LineBasicMaterial({ color: 0x8a8f96 })),
    );
    this.scene.add(this.cube);

    // Capture phase so a click on the cube doesn't also start an orbit drag.
    dom.addEventListener(
      'pointerdown',
      (e) => {
        const face = this.pick(e);
        if (face < 0) return;
        e.stopImmediatePropagation();
        e.preventDefault();
        this.onSelect(FACES[face].view);
      },
      { capture: true },
    );
    dom.addEventListener('pointermove', (e) => {
      if (e.buttons !== 0) return; // dragging the main view
      this.setHovered(this.pick(e));
    });
    dom.addEventListener('pointerleave', () => this.setHovered(-1));
  }

  /** Draw the cube into the corner, after the main scene has been drawn. */
  render(renderer: THREE.WebGLRenderer, mainCamera: THREE.Camera, width: number): void {
    // Same orientation as the main camera, looking at the cube's center from a fixed distance.
    this.camera.quaternion.copy(mainCamera.quaternion);
    this.camera.position.set(0, 0, 4).applyQuaternion(mainCamera.quaternion);
    this.camera.updateMatrixWorld();

    this.axesCamera.quaternion.copy(this.camera.quaternion);
    this.axesCamera.position.copy(this.camera.position);
    this.axesCamera.updateMatrixWorld();

    const x = width - this.rightInset - this.size - this.margin;
    renderer.setScissorTest(true);
    renderer.setScissor(x, this.margin, this.size, this.size);
    renderer.setViewport(x, this.margin, this.size, this.size);
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);

    // Axes sit to the left of the cube, vertically centred on it.
    const ax = x - this.axesSize;
    const ay = this.margin + (this.size - this.axesSize) / 2;
    renderer.setScissor(ax, ay, this.axesSize, this.axesSize);
    renderer.setViewport(ax, ay, this.axesSize, this.axesSize);
    renderer.clearDepth();
    renderer.render(this.axesScene, this.axesCamera);
    renderer.setScissorTest(false);
  }

  /** Index of the face under the pointer, or −1. */
  private pick(e: PointerEvent): number {
    const rect = this.dom.getBoundingClientRect();
    const left = rect.width - this.rightInset - this.size - this.margin;
    const top = rect.height - this.size - this.margin;
    const x = e.clientX - rect.left - left;
    const y = e.clientY - rect.top - top;
    if (x < 0 || y < 0 || x > this.size || y > this.size) return -1;
    const ndc = new THREE.Vector2((x / this.size) * 2 - 1, -((y / this.size) * 2 - 1));
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObject(this.cube, false)[0];
    return hit?.face?.materialIndex ?? -1;
  }

  private setHovered(face: number): void {
    if (face === this.hovered) return;
    if (this.hovered >= 0) this.materials[this.hovered].color.set(0xffffff);
    if (face >= 0) this.materials[face].color.set(HOVER_TINT);
    this.hovered = face;
    this.dom.style.cursor = face >= 0 ? 'pointer' : '';
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

function labelTexture(text: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#3a3d41';
  ctx.fillRect(0, 0, 128, 128);
  ctx.fillStyle = '#e8e8e8';
  ctx.font = 'bold 28px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 64, 66);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}
