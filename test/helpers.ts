import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Write an executable Node script to stand in for a spawned binary. The body runs with the same
 * Node that runs the tests. Shebang scripts are not executable on Windows, so suites using this
 * skip there.
 */
export function fakeExe(dir: string, name: string, body: string): string {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/usr/bin/env node\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

export const onPosix = process.platform !== 'win32';
