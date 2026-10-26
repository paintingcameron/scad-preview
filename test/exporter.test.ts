import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportWithOpenscad } from '../src/exporter';
import { fakeExe, onPosix } from './helpers';

let root: string;
let model: string;
let argvLog: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'scad-preview-'));
  model = path.join(root, 'model.scad');
  argvLog = path.join(root, 'argv.json');
  fs.writeFileSync(model, 'cube(1);\n');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** A stand-in OpenSCAD that records its arguments. `linger` keeps it alive so abort has something to kill. */
function scad({ code = 0, out = '', err = '', linger = false } = {}): string {
  return fakeExe(
    root,
    'openscad',
    `const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write(${JSON.stringify(out)});
process.stderr.write(${JSON.stringify(err)});
if (${linger}) setTimeout(() => process.exit(0), 10000);
else process.exit(${code});`,
  );
}

function args(): string[] {
  return JSON.parse(fs.readFileSync(argvLog, 'utf8')) as string[];
}

describe.skipIf(!onPosix)('exportWithOpenscad', () => {
  it('succeeds when OpenSCAD exits cleanly', async () => {
    const result = await exportWithOpenscad(scad(), model, [], path.join(root, 'out.3mf'), new AbortController().signal);
    expect(result.ok).toBe(true);
  });

  it('fails when OpenSCAD exits with an error, keeping its output', async () => {
    const exe = scad({ code: 1, err: 'ERROR: boom\n' });
    const result = await exportWithOpenscad(exe, model, [], path.join(root, 'out.3mf'), new AbortController().signal);
    expect(result.ok).toBe(false);
    expect(result.output).toContain('ERROR: boom');
  });

  it('reports a missing executable instead of throwing', async () => {
    const result = await exportWithOpenscad(
      path.join(root, 'no-such-openscad'),
      model,
      [],
      path.join(root, 'out.3mf'),
      new AbortController().signal,
    );
    expect(result.ok).toBe(false);
    expect(result.output).not.toBe('');
  });

  it('asks for binary STL only when writing .stl', async () => {
    const exe = scad();
    await exportWithOpenscad(exe, model, [], path.join(root, 'out.stl'), new AbortController().signal);
    expect(args()).toContain('binstl');
    await exportWithOpenscad(exe, model, [], path.join(root, 'out.3mf'), new AbortController().signal);
    expect(args()).not.toContain('binstl');
  });

  it('passes parameter overrides before the file', async () => {
    await exportWithOpenscad(scad(), model, ['-D', 'height=10'], path.join(root, 'out.3mf'), new AbortController().signal);
    const a = args();
    expect(a.slice(-3)).toEqual(['-D', 'height=10', model]);
  });

  it('fails when aborted mid-export', async () => {
    const controller = new AbortController();
    const promise = exportWithOpenscad(scad({ linger: true }), model, [], path.join(root, 'out.3mf'), controller.signal);
    await new Promise((r) => setTimeout(r, 150));
    controller.abort();
    expect((await promise).ok).toBe(false);
  });
});
