import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { extractMarked, parseCsg, type Marker } from './modifiers';

export interface DebugParts {
  /** 3MF of every `#` part. */
  highlight?: Uint8Array;
  /** 3MF of every `%` part. */
  background?: Uint8Array;
  /** What went wrong, for the output channel; parts that did render are still returned. */
  errors: string[];
}

export interface DebugRequest {
  exe: string;
  file: string;
  /** The same `-D` overrides as the main render, so the parts match the model on screen. */
  args?: string[];
}

const PARTS: [Marker, 'highlight' | 'background'][] = [
  ['#', 'highlight'],
  ['%', 'background'],
];

/**
 * The slow second pass for `#` and `%` parts: export the evaluated tree as `.csg` (a full
 * evaluation, as long as a render), pull the marked parts out, and render those from their small
 * `.csg` files (quick: nothing left to evaluate). Only the newest run reports; `cancel` stops it.
 */
export class DebugPass {
  private generation = 0;
  private readonly children = new Set<ChildProcess>();
  private workDir?: Promise<string>;

  /** The parts, or undefined when cancelled or superseded. */
  async run(request: DebugRequest): Promise<DebugParts | undefined> {
    this.cancel();
    const gen = ++this.generation;
    const dir = await (this.workDir ??= fs.mkdtemp(path.join(os.tmpdir(), 'scad-preview-debug-')));
    const cwd = path.dirname(request.file);
    const csgFile = path.join(dir, `debug-${gen}.csg`);
    const errors: string[] = [];
    try {
      const exported = await this.openscad(request.exe, ['-o', csgFile, ...(request.args ?? []), request.file], cwd);
      if (gen !== this.generation) return undefined;
      const text = await readText(csgFile);
      if (exported.exitCode !== 0 || text === undefined) {
        return { errors: [`CSG export failed (exit ${exported.exitCode}): ${lastLine(exported.output)}`] };
      }

      const nodes = parseCsg(text);
      const parts: DebugParts = { errors };
      await Promise.all(
        PARTS.map(async ([marker, key]) => {
          const source = extractMarked(nodes, marker);
          if (!source) return;
          const partCsg = path.join(dir, `${key}-${gen}.csg`);
          const partMesh = path.join(dir, `${key}-${gen}.3mf`);
          await fs.writeFile(partCsg, source, 'utf8');
          const rendered = await this.openscad(request.exe, ['--backend=manifold', '--colorscheme=Monotone', '-o', partMesh, partCsg], cwd);
          const mesh = await readBytes(partMesh);
          if (mesh && rendered.exitCode === 0) parts[key] = mesh;
          else if (gen === this.generation) errors.push(`${marker} parts did not render (exit ${rendered.exitCode}): ${lastLine(rendered.output)}`);
          await Promise.all([partCsg, partMesh].map((f) => fs.rm(f, { force: true })));
        }),
      );
      return gen === this.generation ? parts : undefined;
    } catch (err) {
      return gen === this.generation ? { errors: [String(err)] } : undefined;
    } finally {
      await fs.rm(csgFile, { force: true });
    }
  }

  cancel(): void {
    this.generation++;
    for (const child of this.children) killGroup(child);
    this.children.clear();
  }

  dispose(): void {
    this.cancel();
    void this.workDir?.then((dir) => fs.rm(dir, { recursive: true, force: true }));
  }

  private openscad(exe: string, args: string[], cwd: string): Promise<{ exitCode: number | null; output: string }> {
    // Detached, so the pid is a process group: killing it stops the AppImage and what it started.
    const child = spawn(exe, args, { cwd, detached: true });
    this.children.add(child);
    let output = '';
    child.stdout.on('data', (d: Buffer) => (output += d.toString()));
    child.stderr.on('data', (d: Buffer) => (output += d.toString()));
    return new Promise((resolve) => {
      child.on('error', (err) => {
        this.children.delete(child);
        resolve({ exitCode: null, output: `${output}${err.message}\n` });
      });
      child.on('close', (code) => {
        this.children.delete(child);
        resolve({ exitCode: code, output });
      });
    });
  }
}

function killGroup(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}

async function readBytes(file: string): Promise<Uint8Array | undefined> {
  try {
    return new Uint8Array(await fs.readFile(file));
  } catch {
    return undefined;
  }
}

async function readText(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

function lastLine(output: string): string {
  return output.trim().split(/\r?\n/).at(-1) ?? '';
}
