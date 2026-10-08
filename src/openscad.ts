import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Find the newest `OpenSCAD*.AppImage` in `startDir` or any directory above it.
 * Newest = highest name in sort order, which works for the date-stamped nightly names.
 */
export function findAppImage(startDir: string): string | undefined {
  let dir = path.resolve(startDir);
  for (;;) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      // Unreadable directory: keep walking up.
    }
    const hits = entries.filter((f) => /^OpenSCAD.*\.AppImage$/i.test(f)).sort();
    if (hits.length > 0) return path.join(dir, hits[hits.length - 1]);
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Resolve the OpenSCAD executable: explicit setting, then a nearby AppImage, then PATH. */
export function resolveOpenscadPath(setting: string, searchDirs: string[]): string {
  if (setting.trim()) return setting.trim();
  for (const dir of searchDirs) {
    const hit = findAppImage(dir);
    if (hit) return hit;
  }
  return 'openscad';
}

/** Return the version string, e.g. "2026.09.27". OpenSCAD prints it to stderr. */
export function getOpenscadVersion(exe: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(exe, ['--version'], { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) return reject(err);
      const text = `${stdout}${stderr}`;
      const match = /OpenSCAD version (\S+)/.exec(text);
      if (!match) return reject(new Error(`Unexpected --version output: ${text.trim()}`));
      resolve(match[1]);
    });
  });
}
