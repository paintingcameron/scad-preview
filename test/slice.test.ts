import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findSnap, fitCircle, sliceMesh, type Loop } from '../webview/slice';
import { parse3mf } from '../webview/threemf';

// colors.scad: a 20×20×10 box with a Ø5 hole at (10, 10), a sphere r=5 at (0, 30, 0), and a 4 mm cube at (30, 0, 0).
const { positions } = parse3mf(new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures', 'colors.3mf'))));

function bounds(loop: Loop): [number, number, number, number] {
  const us = loop.points.filter((_, i) => i % 2 === 0);
  const vs = loop.points.filter((_, i) => i % 2 === 1);
  return [Math.min(...us), Math.min(...vs), Math.max(...us), Math.max(...vs)];
}

describe('sliceMesh', () => {
  const slice = sliceMesh(positions, 2, 2); // z = 2 cuts all four outlines

  it('finds every outline as a closed loop', () => {
    expect(slice.loops).toHaveLength(4);
    expect(slice.loops.every((l) => l.closed)).toBe(true);
  });

  it('reduces straight sides to their corners', () => {
    const squares = slice.loops.filter((l) => l.points.length === 8);
    expect(squares.map(bounds).sort((a, b) => a[0] - b[0])).toEqual([
      [0, 0, 20, 20],
      [30, 0, 34, 4],
    ]);
  });

  it('recognises the hole and the sphere section as circles', () => {
    const circles = slice.loops.filter((l) => l.circle).map((l) => l.circle!);
    expect(circles).toHaveLength(2);
    const hole = circles.find((c) => Math.abs(c.cu - 10) < 1e-6)!;
    expect(hole.cv).toBeCloseTo(10, 6);
    expect(hole.r).toBeCloseTo(2.5, 6);
    const sphere = circles.find((c) => Math.abs(c.cv - 30) < 1e-6)!;
    // The sphere is faceted ($fn=24), so its section is close to, not exactly, sqrt(5² − 2²).
    expect(sphere.r).toBeGreaterThan(4.4);
    expect(sphere.r).toBeLessThan(Math.sqrt(21) + 1e-6);
  });

  it('uses the right axes for a cut across X', () => {
    const across = sliceMesh(positions, 0, 31); // x = 31 cuts only the small cube: (y, z) square
    expect(across.loops).toHaveLength(1);
    expect(bounds(across.loops[0])).toEqual([0, 0, 4, 4]);
  });

  it('gives closed outlines when the plane lies exactly on a face', () => {
    // z = 0 is the bottom face of every part and x = 30 the small cube's side: degenerate without the nudge.
    for (const [axis, offset] of [[2, 0], [0, 30]] as const) {
      const cut = sliceMesh(positions, axis, offset);
      expect(cut.loops.length).toBeGreaterThan(0);
      expect(cut.loops.every((l) => l.closed)).toBe(true);
    }
  });

  it('returns nothing when the plane misses the model', () => {
    expect(sliceMesh(positions, 2, 50).loops).toHaveLength(0);
  });
});

describe('findSnap', () => {
  const slice = sliceMesh(positions, 2, 2);

  it('prefers a nearby corner', () => {
    expect(findSnap(slice, 19.8, 0.1, 0.5)).toMatchObject({ kind: 'vertex', u: 20, v: 0 });
  });

  it('snaps to a hole centre', () => {
    const snap = findSnap(slice, 10.2, 9.9, 0.5)!;
    expect(snap.kind).toBe('center');
    // Mesh coordinates are 32-bit floats, so the fitted centre is good to ~1e-8, not exact.
    expect(snap.u).toBeCloseTo(10, 6);
    expect(snap.v).toBeCloseTo(10, 6);
  });

  it('snaps onto an edge between corners', () => {
    const snap = findSnap(slice, 5, 0.2, 0.5)!;
    expect(snap.kind).toBe('edge');
    expect(snap.u).toBeCloseTo(5);
    expect(snap.v).toBeCloseTo(0);
  });

  it('leaves free points alone', () => {
    expect(findSnap(slice, 5, 5, 0.5)).toBeUndefined();
  });
});

describe('fitCircle', () => {
  it('rejects a square', () => {
    expect(fitCircle([0, 0, 1, 0, 1, 1, 0, 1, 0, 0.5, 0.5, 0, 1, 0.5, 0.5, 1])).toBeUndefined();
  });
});
