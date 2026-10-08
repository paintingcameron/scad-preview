import { describe, expect, it } from 'vitest';
import { parseDepsFile, parseEchoes, parseScadMessages } from '../src/messages';

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

describe('parseDepsFile', () => {
  it('reads make-style continuation lines and escaped spaces', () => {
    const text = '/tmp/out.3mf: \\\n\t/work/main.scad \\\n\t/work/my\\ libs/helper.scad\n';
    expect(parseDepsFile(text)).toEqual(['/work/main.scad', '/work/my libs/helper.scad']);
  });

  it('returns nothing for an empty file', () => {
    expect(parseDepsFile('')).toEqual([]);
  });
});
