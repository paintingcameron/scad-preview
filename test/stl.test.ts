import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { binaryStl } from '../src/stl';
import { parse3mf } from '../webview/threemf';

describe('binaryStl', () => {
  it('writes the count, a unit normal and the corners of each triangle', () => {
    const stl = binaryStl([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(stl.length).toBe(84 + 50);
    const view = new DataView(stl.buffer);
    expect(view.getUint32(80, true)).toBe(1);
    expect([0, 1, 2].map((i) => view.getFloat32(84 + i * 4, true))).toEqual([0, 0, 1]); // counter-clockwise from above: +Z
    expect([3, 4, 5].map((i) => view.getFloat32(84 + i * 4, true))).toEqual([0, 0, 0]);
    expect([6, 7, 8].map((i) => view.getFloat32(84 + i * 4, true))).toEqual([1, 0, 0]);
  });

  it('converts a whole rendered model', () => {
    const { positions } = parse3mf(new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures', 'colors.3mf'))));
    const stl = binaryStl(positions);
    expect(new DataView(stl.buffer).getUint32(80, true)).toBe(positions.length / 9);
    expect(stl.length).toBe(84 + (positions.length / 9) * 50);
  });
});
