import { strFromU8, unzipSync } from 'fflate';

/** sRGB color with alpha, each channel 0..1. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/**
 * A triangle soup: 9 floats per triangle in `positions`, one material index per triangle.
 * Material 0 always means "no color()" so the viewer can draw it in a color of its choosing.
 */
export interface MeshData {
  positions: Float32Array;
  materialIndex: Uint32Array;
  materials: Rgba[];
}

/** OpenSCAD's default model color (#F9D72C), stored in material 0 for uncolored triangles. */
export const DEFAULT_COLOR: Rgba = { r: 0xf9 / 255, g: 0xd7 / 255, b: 0x2c / 255, a: 1 };

/** Unzip a .3mf file and parse its model part. */
export function parse3mf(bytes: Uint8Array): MeshData {
  const files = unzipSync(bytes, { filter: (f) => /^3D\/.+\.model$/i.test(f.name) });
  const name = Object.keys(files)[0];
  if (!name) throw new Error('3MF file has no 3D model part');
  return parseModelXml(strFromU8(files[name]));
}

interface ObjectMesh {
  vertices: number[];
  triangles: number[];
  triMaterial: number[];
}

/**
 * Parse 3MF model XML. Supports what OpenSCAD writes: <basematerials> or <m:colorgroup> colors,
 * per-triangle `pid`/`p1`, object-level default `pid`/`pindex`, and build item transforms.
 * Regex-based rather than DOMParser so it is fast on large meshes and runs in Node tests.
 */
export function parseModelXml(xml: string): MeshData {
  const materials: Rgba[] = [DEFAULT_COLOR];
  const materialKey = new Map<string, number>();

  for (const group of xml.matchAll(/<(?:m:)?basematerials\b([^>]*)>([\s\S]*?)<\/(?:m:)?basematerials>/g)) {
    const id = attr(group[1], 'id');
    let i = 0;
    for (const base of group[2].matchAll(/<(?:m:)?base\b([^>]*)>/g)) {
      // OpenSCAD names the uncolored material "Default"; fold it into material 0.
      const index = attr(base[1], 'name') === 'Default' ? 0 : materials.push(parseHexColor(attr(base[1], 'displaycolor'))) - 1;
      materialKey.set(`${id}:${i++}`, index);
    }
  }
  for (const group of xml.matchAll(/<(?:m:)?colorgroup\b([^>]*)>([\s\S]*?)<\/(?:m:)?colorgroup>/g)) {
    const id = attr(group[1], 'id');
    let i = 0;
    for (const color of group[2].matchAll(/<(?:m:)?color\b([^>]*)>/g)) {
      materialKey.set(`${id}:${i++}`, materials.push(parseHexColor(attr(color[1], 'color'))) - 1);
    }
  }

  const objects = new Map<string, ObjectMesh>();
  for (const obj of xml.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object>/g)) {
    const id = attr(obj[1], 'id');
    const body = obj[2];
    if (!id || !body.includes('<mesh')) continue;
    const objPid = attr(obj[1], 'pid');
    const objPindex = attr(obj[1], 'pindex');
    const objDefault = objPid !== undefined ? (materialKey.get(`${objPid}:${objPindex ?? '0'}`) ?? 0) : 0;

    const vertices: number[] = [];
    for (const v of body.matchAll(/<vertex\b([^>]*)>/g)) {
      // Fast path for the attribute order OpenSCAD writes; any other order goes through attr().
      const fast = FAST_VERTEX.exec(v[1]);
      if (fast) vertices.push(Number(fast[1]), Number(fast[2]), Number(fast[3]));
      else vertices.push(Number(attr(v[1], 'x')), Number(attr(v[1], 'y')), Number(attr(v[1], 'z')));
    }
    const triangles: number[] = [];
    const triMaterial: number[] = [];
    for (const t of body.matchAll(/<triangle\b([^>]*)>/g)) {
      const fast = FAST_TRIANGLE.exec(t[1]);
      let pid: string | undefined;
      let p1: string | undefined;
      if (fast) {
        triangles.push(Number(fast[1]), Number(fast[2]), Number(fast[3]));
        pid = fast[4] ?? objPid;
        p1 = fast[5];
      } else {
        triangles.push(Number(attr(t[1], 'v1')), Number(attr(t[1], 'v2')), Number(attr(t[1], 'v3')));
        pid = attr(t[1], 'pid') ?? objPid;
        p1 = attr(t[1], 'p1');
      }
      triMaterial.push(p1 !== undefined && pid !== undefined ? (materialKey.get(`${pid}:${p1}`) ?? objDefault) : objDefault);
    }
    objects.set(id, { vertices, triangles, triMaterial });
  }

  // Build items say which objects to place and where. No items: place every object as-is.
  const items = [...xml.matchAll(/<item\b([^>]*)>/g)].map((m) => ({
    objectId: attr(m[1], 'objectid') ?? '',
    transform: attr(m[1], 'transform')?.trim().split(/\s+/).map(Number),
  }));
  const placements = items.length > 0 ? items : [...objects.keys()].map((objectId) => ({ objectId, transform: undefined }));

  let triCount = 0;
  for (const p of placements) triCount += (objects.get(p.objectId)?.triangles.length ?? 0) / 3;
  const positions = new Float32Array(triCount * 9);
  const materialIndex = new Uint32Array(triCount);

  let t = 0;
  for (const p of placements) {
    const obj = objects.get(p.objectId);
    if (!obj) continue;
    const m = p.transform?.length === 12 ? p.transform : undefined;
    for (let i = 0; i < obj.triangles.length; i += 3, t++) {
      for (let k = 0; k < 3; k++) {
        const vi = obj.triangles[i + k] * 3;
        let x = obj.vertices[vi];
        let y = obj.vertices[vi + 1];
        let z = obj.vertices[vi + 2];
        if (m) {
          // 3MF matrices are row-major 4x3 applied to row vectors: p' = p * M.
          [x, y, z] = [
            x * m[0] + y * m[3] + z * m[6] + m[9],
            x * m[1] + y * m[4] + z * m[7] + m[10],
            x * m[2] + y * m[5] + z * m[8] + m[11],
          ];
        }
        const o = t * 9 + k * 3;
        positions[o] = x;
        positions[o + 1] = y;
        positions[o + 2] = z;
      }
      materialIndex[t] = obj.triMaterial[i / 3];
    }
  }

  return { positions, materialIndex, materials };
}

const FAST_VERTEX = /^\s*x="([^"]*)"\s+y="([^"]*)"\s+z="([^"]*)"\s*\/?$/;
const FAST_TRIANGLE = /^\s*v1="(\d+)"\s+v2="(\d+)"\s+v3="(\d+)"(?:\s+pid="(\d+)")?(?:\s+p1="(\d+)")?\s*\/?$/;

const attrPatterns = new Map<string, RegExp>();

function attr(attrs: string, name: string): string | undefined {
  let re = attrPatterns.get(name);
  if (!re) {
    re = new RegExp(`(?:^|\\s)${name}="([^"]*)"`);
    attrPatterns.set(name, re);
  }
  return re.exec(attrs)?.[1];
}

/** Parse `#RRGGBB` or `#RRGGBBAA`. Anything else falls back to the default color. */
export function parseHexColor(hex: string | undefined): Rgba {
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(hex?.trim() ?? '');
  if (!m) return DEFAULT_COLOR;
  const n = parseInt(m[1], 16);
  return {
    r: ((n >> 16) & 0xff) / 255,
    g: ((n >> 8) & 0xff) / 255,
    b: (n & 0xff) / 255,
    a: m[2] ? parseInt(m[2], 16) / 255 : 1,
  };
}
