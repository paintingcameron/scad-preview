import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defineArgs, parseCustomizer, pruneValues, scadLiteral, type ParamDef } from '../src/customizer';

const dir = path.join(__dirname, 'fixtures', 'customizer');

/** Each fixture's .param file was written by OpenSCAD 2026.09.27 (`-o x.param`); we must match it. */
describe.each(['types', 'rules', 'rules2'])('parseCustomizer matches OpenSCAD on %s.scad', (name) => {
  it('produces the same parameters', () => {
    const source = fs.readFileSync(path.join(dir, `${name}.scad`), 'utf8');
    const expected = JSON.parse(fs.readFileSync(path.join(dir, `${name}.param`), 'utf8')).parameters;
    // `note` is our own addition, not part of OpenSCAD's export.
    const ours = parseCustomizer(source).map(({ note: _note, ...def }) => def);
    expect(ours).toEqual(expected);
  });
});

describe('parseCustomizer', () => {
  it('keeps a same-line comment that is not a spec as a note', () => {
    const [gap, ranged, stepped] = parseCustomizer('gap = 5; // to the inner edge\nr = 2; // [0:5]\ns = 3; // 10\n');
    expect(gap.note).toBe('to the inner edge');
    expect(ranged.note).toBeUndefined();
    expect(stepped.note).toBeUndefined();
  });

  it('decodes string escapes', () => {
    expect(parseCustomizer('s = "a\\"b\\\\c\\u00e9";')[0].initial).toBe('a"b\\cé');
  });

  it('ignores assignments inside blocks and after a module', () => {
    const names = parseCustomizer('a = 1;\nif (x) { b = 2; }\nc = 3;\nmodule m() {}\nd = 4;').map((p) => p.name);
    expect(names).toEqual(['a', 'c']);
  });
});

describe('scadLiteral / defineArgs', () => {
  it('formats each value type as OpenSCAD source', () => {
    expect(scadLiteral(12.5)).toBe('12.5');
    expect(scadLiteral(-3)).toBe('-3');
    expect(scadLiteral(true)).toBe('true');
    expect(scadLiteral('hi "q"')).toBe('"hi \\"q\\""');
    expect(scadLiteral([1, 2.5])).toBe('[1, 2.5]');
  });

  it('builds -D pairs', () => {
    expect(defineArgs({ size: 3, $fn: 12 })).toEqual(['-D', 'size=3', '-D', '$fn=12']);
  });
});

describe('pruneValues', () => {
  const defs: ParamDef[] = [
    { name: 'a', type: 'number', initial: 1, group: 'G', step: 1 },
    { name: 'v', type: 'number', initial: [1, 2], group: 'G' },
    { name: 's', type: 'string', initial: 'x', group: 'G' },
  ];

  it('drops defaults, unknown names, type changes and wrong vector lengths', () => {
    expect(pruneValues({ a: 1, gone: 5, s: 3, v: [1, 2, 3] }, defs)).toEqual({});
    expect(pruneValues({ a: 2, s: 'y', v: [3, 4] }, defs)).toEqual({ a: 2, s: 'y', v: [3, 4] });
  });
});
