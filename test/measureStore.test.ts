import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadMeasures, measurePath, parseMeasureFile, saveMeasures, type SavedMeasures } from '../src/measureStore';

describe('measurePath', () => {
  it('puts the file in a hidden folder next to the model', () => {
    expect(measurePath('/work/parts/trainer-v2.scad')).toBe('/work/parts/.scad-preview/trainer-v2.measure.json');
  });
});

describe('parseMeasureFile', () => {
  it('treats a missing or broken file as no measurements', () => {
    expect(parseMeasureFile(undefined)).toEqual({ measurements: [], hiddenCode: [] });
    expect(parseMeasureFile('{ not json')).toEqual({ measurements: [], hiddenCode: [] });
  });

  it('keeps good entries and skips malformed ones', () => {
    const text = JSON.stringify({
      version: 1,
      measurements: [
        { a: [0, 0, 0], b: [1, 2, 3], label: 'wall', hidden: true },
        { a: [0, 0], b: [1, 2, 3] },
        { a: [0, 0, 0], b: [1, 'x', 3] },
        { a: [4, 5, 6], b: [7, 8, 9], label: '' },
      ],
      hiddenCode: ['dent to tunnel', 3, '#1'],
    });
    expect(parseMeasureFile(text)).toEqual({
      measurements: [
        { a: [0, 0, 0], b: [1, 2, 3], label: 'wall', hidden: true },
        { a: [4, 5, 6], b: [7, 8, 9] },
      ],
      hiddenCode: ['dent to tunnel', '#1'],
    });
  });
});

describe('saveMeasures / loadMeasures', () => {
  let dir: string;
  let scad: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'measure-'));
    scad = path.join(dir, 'model.scad');
  });
  afterEach(() => fs.rm(dir, { recursive: true, force: true }));

  it('round-trips, creating the hidden folder', async () => {
    const saved: SavedMeasures = { measurements: [{ a: [0, 0, 17.5], b: [3, 0, 17.5], label: 'gap' }], hiddenCode: ['#0'] };
    await saveMeasures(scad, saved);
    expect(await loadMeasures(scad)).toEqual(saved);
  });

  it('removes the file and the empty folder when nothing is left', async () => {
    await saveMeasures(scad, { measurements: [{ a: [0, 0, 0], b: [1, 1, 1] }], hiddenCode: [] });
    await saveMeasures(scad, { measurements: [], hiddenCode: [] });
    await expect(fs.stat(path.join(dir, '.scad-preview'))).rejects.toThrow();
  });

  it('writes nothing for a model that never had measurements', async () => {
    await saveMeasures(scad, { measurements: [], hiddenCode: [] });
    expect(await fs.readdir(dir)).toEqual([]);
  });
});
