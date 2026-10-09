/**
 * Ray against a raw triangle list (x, y, z per corner, three corners per triangle), hitting faces
 * from either side. Three's raycaster skips back faces of one-sided materials, so it can't follow a
 * ray that starts inside a part, which is what wall thickness needs. No Three.js, so it runs in tests.
 */
export type Vec3 = [number, number, number];

/** Distance along the ray (dir should be unit length) to the nearest triangle beyond `minT`. */
export function castRay(positions: ArrayLike<number>, origin: Vec3, dir: Vec3, minT = 1e-6): number | undefined {
  const [ox, oy, oz] = origin;
  const [dx, dy, dz] = dir;
  let best: number | undefined;
  for (let t = 0; t + 8 < positions.length; t += 9) {
    // Möller–Trumbore.
    const ax = positions[t], ay = positions[t + 1], az = positions[t + 2];
    const e1x = positions[t + 3] - ax, e1y = positions[t + 4] - ay, e1z = positions[t + 5] - az;
    const e2x = positions[t + 6] - ax, e2y = positions[t + 7] - ay, e2z = positions[t + 8] - az;
    const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-12) continue; // ray parallel to the triangle
    const inv = 1 / det;
    const sx = ox - ax, sy = oy - ay, sz = oz - az;
    const u = (sx * px + sy * py + sz * pz) * inv;
    if (u < 0 || u > 1) continue;
    const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
    const v = (dx * qx + dy * qy + dz * qz) * inv;
    if (v < 0 || u + v > 1) continue;
    const dist = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (dist > minT && (best === undefined || dist < best)) best = dist;
  }
  return best;
}
