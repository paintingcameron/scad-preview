import { describe, expect, it } from 'vitest';
import { parseDepsFile, parseEchoes, parseMeasureEchoes, parseScadMessages } from '../src/messages';

// Captured from OpenSCAD 2026.09.27 rendering /work/main.scad, which `use`s lib/helper.scad.
const output = `WARNING: Ignoring unknown variable "undefined_in_lib" in file lib/helper.scad, line 2
WARNING: Ignoring unknown variable "bad_var" in file main.scad, line 3
ECHO: "probe done", 20
ERROR: Assertion 'false' failed: "boom" in file main.scad, line 4
TRACE: called by 'assert' in file main.scad, line 4
Geometries in cache: 1
Total rendering time: 0:00:00.076
`;

describe('parseScadMessages', () => {
  const messages = parseScadMessages(output, '/work/main.scad');

  it('finds errors and warnings with locations resolved against the main file', () => {
    expect(messages.map((m) => [m.severity, m.location?.file, m.location?.line])).toEqual([
      ['warning', '/work/lib/helper.scad', 2],
      ['warning', '/work/main.scad', 3],
      ['error', '/work/main.scad', 4],
    ]);
    expect(messages[0].message).toBe('Ignoring unknown variable "undefined_in_lib"');
  });

  it('attaches TRACE lines to the message before them', () => {
    expect(messages[2].trace).toEqual([
      { message: "called by 'assert'", location: { file: '/work/main.scad', line: 4 } },
    ]);
  });

  it('handles parser errors and messages without a location', () => {
    const parsed = parseScadMessages(
      "ERROR: Parser error: syntax error in file bad.scad, line 3\nERROR: Something odd\nCan't parse file 'bad.scad'!",
      '/work/bad.scad',
    );
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ message: 'Parser error: syntax error', location: { line: 3 } });
    expect(parsed[1].location).toBeUndefined();
  });
});

describe('parseEchoes', () => {
  it('returns echo text without the prefix', () => {
    expect(parseEchoes(output)).toEqual(['"probe done", 20']);
  });
});

describe('parseMeasureEchoes', () => {
  // Captured from OpenSCAD 2026.09.27 (it rounds to 6 significant digits and doesn't escape quotes).
  const echoes = [
    '"measure", [0, 0, 2], [20, 5, 2], undef',
    '"measure", [0, 0, 0], [7.5, -1e-6, 0.333333], "wall "inner""',
    '"measure", [1, 2], [3, 4], "flat"',
    '"measure", [0, 0, 0], [1, 1, 1]',
    '"other", 5',
    '"measure", [0, 0, 0], undef',
    '"measure", [0, 0, 0], [nan, 0, 0]',
  ];

  it('reads points, labels and 2D points, skipping other echoes', () => {
    const { measures } = parseMeasureEchoes(echoes);
    expect(measures).toEqual([
      { a: [0, 0, 2], b: [20, 5, 2], label: undefined },
      { a: [0, 0, 0], b: [7.5, -1e-6, 0.333333], label: 'wall "inner"' },
      { a: [1, 2, 0], b: [3, 4, 0], label: 'flat' },
      { a: [0, 0, 0], b: [1, 1, 1], label: undefined },
    ]);
  });

  it('reports measure echoes it cannot read', () => {
    expect(parseMeasureEchoes(echoes).bad).toEqual(['"measure", [0, 0, 0], undef', '"measure", [0, 0, 0], [nan, 0, 0]']);
  });
});

describe('parseDepsFile', () => {
  it('reads make-style continuation lines and escaped spaces', () => {
    const text = '/tmp/out.3mf: \\\n\t/work/main.scad \\\n\t/work/my\\ libs/helper.scad\n';
    expect(parseDepsFile(text)).toEqual(['/work/main.scad', '/work/my libs/helper.scad']);
  });

  it('returns nothing for an empty file', () => {
    expect(parseDepsFile('')).toEqual([]);
  });
});
