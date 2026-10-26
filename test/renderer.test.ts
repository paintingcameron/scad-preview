import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RenderQueue, type RenderRequest, type RenderResult } from '../src/renderer';
import { fakeExe, onPosix } from './helpers';

let root: string;
let model: string;
let runs: string;
let queues: RenderQueue[];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'scad-preview-'));
  model = path.join(root, 'model.scad');
  runs = path.join(root, 'runs.log');
  queues = [];
  fs.writeFileSync(model, 'cube(1);\n');
});

afterEach(() => {
  for (const q of queues) q.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});

/** A stand-in OpenSCAD that writes the files the real one writes for `-o`, `-d` and `--summary-file`. */
function scad({ code = 0, output = '', writeModel = true, sleepMs = 0 } = {}): string {
  const deps = `out.3mf: \\\n\t${model}\n`;
  return fakeExe(
    root,
    'openscad',
    `const fs = require('node:fs');
const a = process.argv.slice(2);
const val = (f) => a[a.indexOf(f) + 1];
fs.appendFileSync(${JSON.stringify(runs)}, JSON.stringify(a) + '\\n');
if (${writeModel}) fs.writeFileSync(val('-o'), 'MODEL');
fs.writeFileSync(val('-d'), ${JSON.stringify(deps)});
fs.writeFileSync(val('--summary-file'), JSON.stringify({ geometry: { facets: 42 } }));
process.stderr.write(${JSON.stringify(output)});
setTimeout(() => process.exit(${code}), ${sleepMs});`,
  );
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(what: string, done: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!done()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await tick(10);
  }
}

function makeQueue() {
  const starts: RenderRequest[] = [];
  const results: RenderResult[] = [];
  const q = new RenderQueue(
    (r) => starts.push(r),
    (r) => results.push(r),
  );
  queues.push(q);
  const settled = (n: number) => until(`${n} result(s)`, () => results.length >= n);
  return { q, starts, results, settled };
}

describe.skipIf(!onPosix)('RenderQueue', () => {
  it('reports the model, summary and dependencies of a clean render', async () => {
    const { q, results, settled } = makeQueue();
    q.request({ exe: scad(), file: model }, { delayMs: 0 });
    await settled(1);
    const result = results[0];
    expect(result.ok).toBe(true);
    expect(result.empty).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(Buffer.from(result.model!).toString()).toBe('MODEL');
    expect(result.summary?.geometry?.facets).toBe(42);
    expect(result.deps).toEqual([model]);
  });

  it('fails when OpenSCAD exits with an error', async () => {
    const { q, results, settled } = makeQueue();
    q.request({ exe: scad({ code: 1, writeModel: false, output: 'ERROR: boom\n' }), file: model }, { delayMs: 0 });
    await settled(1);
    expect(results[0].ok).toBe(false);
    expect(results[0].output).toContain('ERROR: boom');
  });

  it('flags a model that renders to nothing', async () => {
    const { q, results, settled } = makeQueue();
    q.request({ exe: scad({ output: 'Current top level object is empty.\n' }), file: model }, { delayMs: 0 });
    await settled(1);
    expect(results[0].empty).toBe(true);
  });

  it('reports a missing executable instead of throwing', async () => {
    const { q, results, settled } = makeQueue();
    q.request({ exe: path.join(root, 'no-such-openscad'), file: model }, { delayMs: 0 });
    await settled(1);
    expect(results[0].ok).toBe(false);
    expect(results[0].exitCode).toBeNull();
  });

  it('runs only the last of a burst of requests', async () => {
    const { q, starts, results, settled } = makeQueue();
    const exe = scad();
    q.request({ exe, file: model, args: ['-D', 'a=1'] }, { delayMs: 40 });
    q.request({ exe, file: model, args: ['-D', 'a=2'] }, { delayMs: 40 });
    q.request({ exe, file: model, args: ['-D', 'a=3'] }, { delayMs: 40 });
    await settled(1);
    await tick(150); // long enough for a stray second render to show up
    expect(starts).toHaveLength(1);
    expect(results).toHaveLength(1);
    expect(results[0].request.args).toEqual(['-D', 'a=3']);
  });

  it('drops a request that is cancelled before it starts', async () => {
    const { q, starts, results } = makeQueue();
    q.request({ exe: scad(), file: model }, { delayMs: 50 });
    q.cancel();
    await tick(250);
    expect(starts).toEqual([]);
    expect(results).toEqual([]);
  });

  it('reports nothing when a render in progress is cancelled', async () => {
    const { q, starts, results } = makeQueue();
    q.request({ exe: scad({ sleepMs: 2000 }), file: model }, { delayMs: 0 });
    await until('the render to start', () => q.busy);
    expect(starts).toHaveLength(1);
    q.cancel();
    await tick(300);
    expect(results).toEqual([]);
    expect(q.busy).toBe(false);
  });

  it('lets a render finish and then runs the newest waiting request', async () => {
    const { q, starts, results, settled } = makeQueue();
    const exe = scad({ sleepMs: 200 });
    q.request({ exe, file: model, args: ['-D', 'a=1'] }, { delayMs: 0 });
    await until('the render to start', () => q.busy);

    q.request({ exe, file: model, args: ['-D', 'a=2'] }, { delayMs: 0, interrupt: false });
    q.request({ exe, file: model, args: ['-D', 'a=3'] }, { delayMs: 0, interrupt: false });
    expect(starts).toHaveLength(1); // the first render is still going; the others wait

    await settled(2);
    expect(results[0].request.args).toEqual(['-D', 'a=1']);
    expect(results[1].request.args).toEqual(['-D', 'a=3']); // a=2 was superseded while waiting
    expect(starts).toHaveLength(2);
  });

  it('renders the file, with overrides before it', async () => {
    const { q, settled } = makeQueue();
    q.request({ exe: scad(), file: model, args: ['-D', 'height=10'] }, { delayMs: 0 });
    await settled(1);
    const args = JSON.parse(fs.readFileSync(runs, 'utf8').trim()) as string[];
    expect(args.slice(-3)).toEqual(['-D', 'height=10', model]);
    expect(args).toContain('--backend=manifold');
  });
});
