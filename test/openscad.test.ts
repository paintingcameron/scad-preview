import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findAppImage, resolveOpenscadPath } from '../src/openscad';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'scad-preview-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function touch(...parts: string[]): string {
  const file = path.join(root, ...parts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  return file;
}

describe('findAppImage', () => {
  it('finds an AppImage in a parent directory', () => {
    const image = touch('OpenSCAD-2026.09.27-x86_64.AppImage');
    touch('projects', 'cap', 'cap.scad');
    expect(findAppImage(path.join(root, 'projects', 'cap'))).toBe(image);
  });

  it('picks the newest date-stamped AppImage', () => {
    touch('OpenSCAD-2025.01.01-x86_64.AppImage');
    const newest = touch('OpenSCAD-2026.09.27-x86_64.AppImage');
    expect(findAppImage(root)).toBe(newest);
  });

  it('prefers the nearest directory', () => {
    touch('OpenSCAD-2026.09.27-x86_64.AppImage');
    const near = touch('sub', 'OpenSCAD-2024.01.01-x86_64.AppImage');
    expect(findAppImage(path.join(root, 'sub'))).toBe(near);
  });
});

describe('resolveOpenscadPath', () => {
  it('uses the setting when given', () => {
    touch('OpenSCAD-2026.09.27-x86_64.AppImage');
    expect(resolveOpenscadPath(' /opt/openscad ', [root])).toBe('/opt/openscad');
  });

  it('falls back to a nearby AppImage', () => {
    const image = touch('OpenSCAD-2026.09.27-x86_64.AppImage');
    expect(resolveOpenscadPath('', [root])).toBe(image);
  });
});
