import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RenderResult } from '../src/renderer';
import { RenderCache } from '../src/renderCache';

function result(bytes: number): RenderResult {
  return {
    request: { exe: 'openscad', file: 'a.scad' },
    ok: true,
    empty: false,
    model: new Uint8Array(bytes),
    deps: [],
    output: '',
    exitCode: 0,
    ms: 1000,
  };
}

describe('RenderCache', () => {
  let dir: string;
  let main: string;
  let lib: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cache-'));
    main = path.join(dir, 'main.scad');
    lib = path.join(dir, 'lib.scad');
    await fs.writeFile(main, 'include <lib.scad>\nthing();');
    await fs.writeFile(lib, 'module thing() cube(1);');
  });
  afterEach(() => fs.rm(dir, { recursive: true, force: true }));

  it('gives the same key for the same program, values and file contents', async () => {
    const cache = new RenderCache();
    const a = await cache.key('openscad', ['-D', 'w=1'], [main, lib]);
    expect(await cache.key('openscad', ['-D', 'w=1'], [lib, main, lib])).toBe(a);
    expect(await cache.key('openscad', ['-D', 'w=2'], [main, lib])).not.toBe(a);
    expect(await cache.key('other', ['-D', 'w=1'], [main, lib])).not.toBe(a);
  });

  it('changes the key when an included file changes', async () => {
    const cache = new RenderCache();
    const before = await cache.key('openscad', [], [main, lib]);
    // A different size, so the change is seen even if the clock doesn't tick between writes.
    await fs.writeFile(lib, 'module thing() cube(2.5);');
    expect(await cache.key('openscad', [], [main, lib])).not.toBe(before);
  });

  it('stores and returns results, and drops the least recently used past its size', () => {
    // Each entry counts 1000 bytes plus 1024 of overhead: two fit in 5000, three don't.
    const cache = new RenderCache(5000);
    cache.set('a', result(1000));
    cache.set('b', result(1000));
    expect(cache.get('a')?.result.model?.length).toBe(1000); // a is now the most recent
    cache.set('c', result(1000)); // over the limit: b, the least recently used, goes
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBeDefined();
    expect(cache.get('c')).toBeDefined();
  });

  it('keeps # / % parts with their result', () => {
    const cache = new RenderCache();
    cache.set('a', result(10));
    cache.setDebug('a', { highlight: new Uint8Array(5), errors: [] });
    expect(cache.get('a')?.debug?.highlight?.length).toBe(5);
  });
});
