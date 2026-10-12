import { spawn } from 'node:child_process';
import * as path from 'node:path';

/**
 * Have OpenSCAD write the model straight to `out` (format from its extension), with the same `-D`
 * values as the preview. Aborting stops the process group.
 */
export function exportWithOpenscad(
  exe: string,
  file: string,
  args: string[],
  out: string,
  signal: AbortSignal,
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    // OpenSCAD writes text STL by default; binary is ~6x smaller and matches what the cache route writes.
    const format = out.toLowerCase().endsWith('.stl') ? ['--export-format', 'binstl'] : [];
    const child = spawn(exe, ['--backend=manifold', '--colorscheme=Monotone', ...format, '-o', out, ...args, file], {
      cwd: path.dirname(file),
      detached: true,
    });
    let output = '';
    child.stdout.on('data', (d: Buffer) => (output += d.toString()));
    child.stderr.on('data', (d: Buffer) => (output += d.toString()));
    const stop = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    };
    signal.addEventListener('abort', stop, { once: true });
    child.on('error', (err) => resolve({ ok: false, output: `${output}${err.message}\n` }));
    child.on('close', (code) => {
      signal.removeEventListener('abort', stop);
      resolve({ ok: code === 0 && !signal.aborted, output });
    });
  });
}
