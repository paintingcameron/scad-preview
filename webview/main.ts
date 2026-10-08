import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { FromWebview, ToWebview } from '../src/protocol';

declare function acquireVsCodeApi(): { postMessage(msg: FromWebview): void };
const vscode = acquireVsCodeApi();

// OpenSCAD is Z-up; make Three.js match so coordinates read the same in both.
THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

const container = document.getElementById('viewport')!;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1e1e1e);

const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 10000);
camera.position.set(80, -120, 90);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

const grid = new THREE.GridHelper(200, 20, 0x555555, 0x333333);
grid.rotation.x = Math.PI / 2; // GridHelper lies in XZ; rotate into the XY build plate.
scene.add(grid);
scene.add(new THREE.AxesHelper(30));

scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.5));
const sun = new THREE.DirectionalLight(0xffffff, 1.5);
sun.position.set(100, -100, 200);
scene.add(sun);

// Placeholder so we can see lighting and orbiting work before real models arrive.
const placeholder = new THREE.Mesh(
  new THREE.BoxGeometry(20, 20, 20),
  new THREE.MeshStandardMaterial({ color: 0xf9d72c }),
);
placeholder.position.z = 10;
scene.add(placeholder);

function resize(): void {
  const { clientWidth: w, clientHeight: h } = container;
  renderer.setSize(w, h);
  camera.aspect = w / Math.max(h, 1);
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(container);
resize();

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});

window.addEventListener('message', (event: MessageEvent<ToWebview>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'file':
      document.getElementById('file')!.textContent = msg.name;
      break;
    case 'status': {
      const el = document.getElementById('version')!;
      el.textContent = msg.version
        ? `OpenSCAD ${msg.version}`
        : `OpenSCAD not found (${msg.openscadPath})`;
      el.title = msg.error ?? msg.openscadPath;
      el.classList.toggle('error', !msg.version);
      break;
    }
  }
});

vscode.postMessage({ type: 'ready' });
