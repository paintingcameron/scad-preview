import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { unpackedAppImage } from '../src/appimage';
import { fakeExe, onPosix } from './helpers';

let root: string;
let storage: string;
let runs: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'scad-preview-'));
  storage = path.join(root, 'storage');
  runs = path.join(root, 'runs.log');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** A stand-in AppImage: `--appimage-extract` writes squashfs-root/AppRun into the cwd. */
function appImage(name = 'OpenSCAD.AppImage', { succeed = true, pad = '' } = {}): string {
  return fakeExe(
    root,
    name,
    `${pad}const fs = require('node:fs');
const path = require('node:path');
fs.appendFileSync(${JSON.stringify(runs)}, process.argv.slice(2).join(' ') + '\\n');
if (!${succeed}) process.exit(1);
fs.mkdirSync('squashfs-root', { recursive: true });
fs.writeFileSync(path.join('squashfs-root', 'AppRun'), '');`,
  );
}

function runCount(): number {
  return fs.existsSync(runs) ? fs.readFileSync(runs, 'utf8').trim().split('\n').length : 0;
}

describe.skipIf(!onPosix)('unpackedAppImage', () => {
  it('returns nothing when the AppImage does not exist', async () => {
    expect(await unpackedAppImage(path.join(root, 'missing.AppImage'), storage)).toBeUndefined();
  });

  it('extracts and returns the program inside', async () => {
    const program = await unpackedAppImage(appImage(), storage);
    expect(program).toBeDefined();
    expect(fs.existsSync(program!)).toBe(true);
    expect(path.basename(program!)).toBe('AppRun');
    expect(runs && fs.readFileSync(runs, 'utf8')).toContain('--appimage-extract');
  });

  it('reuses an existing copy instead of extracting again', async () => {
    const image = appImage();
    const first = await unpackedAppImage(image, storage);
    const second = await unpackedAppImage(image, storage);
    expect(second).toBe(first);
    expect(runCount()).toBe(1);
  });

  it('shares one extraction between callers that arrive together', async () => {
    const image = appImage();
    const [a, b] = await Promise.all([unpackedAppImage(image, storage), unpackedAppImage(image, storage)]);
    expect(a).toBe(b);
    expect(runCount()).toBe(1);
  });

  it('returns nothing and leaves no partial copy when extraction fails', async () => {
    expect(await unpackedAppImage(appImage('Bad.AppImage', { succeed: false }), storage)).toBeUndefined();
    const dirs = fs.readdirSync(path.join(storage, 'appimage'));
    expect(dirs.filter((d) => d.includes('.partial-'))).toEqual([]);
  });

  it('re-extracts and drops the old copy when the AppImage changes', async () => {
    const first = await unpackedAppImage(appImage(), storage);
    // Different size and mtime, so it hashes to a different id.
    const second = await unpackedAppImage(appImage('OpenSCAD.AppImage', { pad: '// rebuilt\n' }), storage);
    expect(second).not.toBe(first);
    expect(fs.existsSync(first!)).toBe(false);
    expect(fs.readdirSync(path.join(storage, 'appimage'))).toHaveLength(1);
  });
});
