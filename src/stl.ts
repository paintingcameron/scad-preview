/**
 * Binary STL from a triangle list (x, y, z per corner, three corners per triangle): 80-byte header,
 * triangle count, then per triangle a facet normal, three corners and a 2-byte attribute.
 */
export function binaryStl(positions: ArrayLike<number>, header = 'scad-preview'): Uint8Array {
  const count = Math.floor(positions.length / 9);
  const bytes = new Uint8Array(84 + count * 50);
  bytes.set(new TextEncoder().encode(header.slice(0, 80)));
  const view = new DataView(bytes.buffer);
  view.setUint32(80, count, true);
  for (let t = 0; t < count; t++) {
    const p = (i: number) => positions[t * 9 + i];
    const [ux, uy, uz] = [p(3) - p(0), p(4) - p(1), p(5) - p(2)];
    const [vx, vy, vz] = [p(6) - p(0), p(7) - p(1), p(8) - p(2)];
    let [nx, ny, nz] = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    const len = Math.hypot(nx, ny, nz) || 1;
    [nx, ny, nz] = [nx / len, ny / len, nz / len];
    const at = 84 + t * 50;
    [nx, ny, nz].forEach((n, i) => view.setFloat32(at + i * 4, n, true));
    for (let i = 0; i < 9; i++) view.setFloat32(at + 12 + i * 4, p(i), true);
    view.setUint16(at + 48, 0, true);
  }
  return bytes;
}
