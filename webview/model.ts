import * as THREE from 'three';
import type { MeshData, Rgba } from './threemf';

/** Above this many triangles, edges are skipped: EdgesGeometry gets slow and the lines turn to noise. */
const MAX_EDGE_TRIANGLES = 500_000;

/**
 * Turn parsed 3MF data into meshes. Uncolored triangles (material 0) use `defaultColor`.
 * Opaque triangles share one mesh with per-vertex colors; each transparent color gets its own
 * mesh, drawn without depth writes so what's behind shows through.
 */
export function buildModel(source: MeshData, defaultColor: Rgba): THREE.Group {
  const data: MeshData = { ...source, materials: [defaultColor, ...source.materials.slice(1)] };
  const group = new THREE.Group();
  const opaque: number[] = [];
  const transparent = new Map<number, number[]>();
  for (let t = 0; t < data.materialIndex.length; t++) {
    const mat = data.materialIndex[t];
    if (data.materials[mat].a >= 0.999) opaque.push(t);
    else {
      const list = transparent.get(mat);
      if (list) list.push(t);
      else transparent.set(mat, [t]);
    }
  }

  if (opaque.length > 0) {
    const geometry = geometryFor(data, opaque);
    const colors = new Float32Array(opaque.length * 9);
    const c = new THREE.Color();
    opaque.forEach((t, i) => {
      const m = data.materials[data.materialIndex[t]];
      c.setRGB(m.r, m.g, m.b, THREE.SRGBColorSpace);
      for (let k = 0; k < 3; k++) colors.set([c.r, c.g, c.b], i * 9 + k * 3);
    });
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    group.add(new THREE.Mesh(geometry, surfaceMaterial({ vertexColors: true })));
  }

  for (const [mat, tris] of transparent) {
    const m = data.materials[mat];
    const color = new THREE.Color().setRGB(m.r, m.g, m.b, THREE.SRGBColorSpace);
    const mesh = new THREE.Mesh(
      geometryFor(data, tris),
      surfaceMaterial({ color, opacity: m.a, transparent: true, depthWrite: false, side: THREE.DoubleSide }),
    );
    mesh.renderOrder = 1; // after opaque geometry
    group.add(mesh);
  }

  // Every triangle in one geometry: a closed solid, which the section cap needs.
  const solid = new THREE.BufferGeometry();
  solid.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  solid.computeBoundingSphere();
  group.userData.solid = solid;
  return group;
}

/** How see-through they are, as in OpenSCAD's preview: `#` clearly, `%` faintly. */
const DEBUG_OPACITY = { highlight: 0.45, background: 0.22 };

/** Translucent meshes for the `#` (highlight) and `%` (background) parts, in the given colors. */
export function buildDebugParts(
  parts: { highlight?: MeshData; background?: MeshData },
  colors: { highlight: string; background: string },
): THREE.Group | undefined {
  const group = new THREE.Group();
  for (const key of ['background', 'highlight'] as const) {
    const data = parts[key];
    if (!data || data.positions.length === 0) continue;
    const all = Array.from({ length: data.positions.length / 9 }, (_, t) => t);
    const mesh = new THREE.Mesh(
      geometryFor(data, all),
      surfaceMaterial({
        color: new THREE.Color(colors[key]),
        opacity: DEBUG_OPACITY[key],
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        // A cut leaves the model's surface exactly where the part's is; pull the part forward so it
        // draws cleanly there instead of flickering in and out.
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      }),
    );
    mesh.renderOrder = 2; // after the model, including its transparent parts
    group.add(mesh);
  }
  return group.children.length > 0 ? group : undefined;
}

/** Facet-edge lines for every mesh in the model, or undefined when the model is too large. */
export function buildEdges(model: THREE.Group, thresholdDeg = 30): THREE.Group | undefined {
  let triangles = 0;
  model.traverse((o) => {
    if (o instanceof THREE.Mesh) triangles += o.geometry.getAttribute('position').count / 3;
  });
  if (triangles > MAX_EDGE_TRIANGLES) return undefined;

  const edges = new THREE.Group();
  const material = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35 });
  model.traverse((o) => {
    if (o instanceof THREE.Mesh) edges.add(new THREE.LineSegments(new THREE.EdgesGeometry(o.geometry, thresholdDeg), material));
  });
  return edges;
}

/** Free GPU memory held by everything under `root`. */
export function disposeTree(root: THREE.Object3D): void {
  (root.userData.solid as THREE.BufferGeometry | undefined)?.dispose();
  root.traverse((o) => {
    if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) {
      o.geometry.dispose();
      const materials = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of materials) m.dispose();
    }
  });
}

function geometryFor(data: MeshData, triangles: number[]): THREE.BufferGeometry {
  const positions = new Float32Array(triangles.length * 9);
  triangles.forEach((t, i) => positions.set(data.positions.subarray(t * 9, t * 9 + 9), i * 9));
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.computeVertexNormals(); // non-indexed, so normals come out flat per facet
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function surfaceMaterial(params: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    roughness: 0.65,
    metalness: 0.05,
    // Push faces back slightly so edge lines draw cleanly on top of them.
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
    ...params,
  });
}
