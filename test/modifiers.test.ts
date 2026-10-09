import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractMarked, hasModifiers, parseCsg } from '../src/modifiers';

// mods.scad and its export from OpenSCAD 2026.09.27 (`-o mods.csg`).
const fixtures = path.join(__dirname, 'fixtures', 'modifiers');
const csg = fs.readFileSync(path.join(fixtures, 'mods.csg'), 'utf8');

describe('hasModifiers', () => {
  it('finds # and % used as modifiers', () => {
    expect(hasModifiers(fs.readFileSync(path.join(fixtures, 'mods.scad'), 'utf8'))).toBe(true);
    expect(hasModifiers('translate([1, 0, 0]) #cube(1);')).toBe(true);
    expect(hasModifiers('for (i = [0:1]) %cube(i);')).toBe(true);
    expect(hasModifiers('module m() %sphere(1);')).toBe(true);
  });

  it('ignores % as modulo, and markers in comments, strings and library paths', () => {
    const source = [
      'include <lib/#weird%path.scad>',
      'x = 7 % 3;',
      'function f(a) = a % 2;',
      'if (x % 2 == 0) cube(1);',
      'v = [for (i = [0:3]) i % 2];',
      'echo(str("50%", " #1"));',
      '// #cube(1);',
      '/* %cube(1); */',
      'cube(x >= 1 ? 2 : 3);',
    ].join('\n');
    expect(hasModifiers(source)).toBe(false);
  });
});

describe('parseCsg', () => {
  const nodes = parseCsg(csg);

  it('reads the tree with markers', () => {
    expect(nodes.map((n) => `${n.marker ?? ''}${n.name}`)).toEqual(['color', '%multmatrix', 'multmatrix', 'group', '#multmatrix']);
    const cylinder = nodes[0].children[0].children[1].children[0];
    expect(cylinder).toMatchObject({ marker: '#', name: 'cylinder', children: [] });
    expect(cylinder.args).toBe('$fn = 32, $fa = 12, $fs = 2, h = 12, r1 = 2.5, r2 = 2.5, center = false');
  });

  it('copes with the unescaped quotes OpenSCAD writes in strings, and escapes them', () => {
    const text = nodes[4].children[0].children[0];
    expect(text.name).toBe('text');
    expect(text.args.startsWith('text = "hi \\"q\\"", size = 4')).toBe(true);
  });
});

describe('extractMarked', () => {
  const nodes = parseCsg(csg);

  it('pulls out # parts inside their transforms and colors, without the boolean around them', () => {
    const out = extractMarked(nodes, '#')!;
    // The hole cutter: color > multmatrix > cylinder, with the difference() dropped.
    expect(out).toContain('color([1, 0, 0, 1]) {\n\tmultmatrix([[1, 0, 0, 10], [0, 1, 0, 10], [0, 0, 1, -1], [0, 0, 0, 1]]) {\n\t\tcylinder(');
    expect(out).not.toContain('difference');
    expect(out).not.toMatch(/^\s*#/m); // markers removed, so the part renders
    // The rotated cube keeps both transforms; the highlighted text is kept (extruded, so 3D).
    expect(out).toContain('multmatrix([[0.707107, -0.707107, 0, 0]');
    expect(out).toContain('linear_extrude(height = 1');
    expect(parseCsg(out)).toHaveLength(3); // and it is valid CSG again
  });

  it('pulls out every % part, including both copies from a loop', () => {
    const out = extractMarked(nodes, '%')!;
    expect(out.match(/cylinder\(/g)).toHaveLength(2);
    expect(out.match(/cube\(/g)).toHaveLength(1);
  });

  it('skips 2D shapes and returns nothing when nothing is marked', () => {
    expect(extractMarked(parseCsg('linear_extrude(height = 1) {\n#\tsquare(size = [1, 1], center = false);\n}\n'), '#')).toBeUndefined();
    expect(extractMarked(parseCsg('cube(size = [1, 1, 1], center = false);\n'), '%')).toBeUndefined();
  });
});
