import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseDepsFile } from './messages';

/** The parts of OpenSCAD's `--summary-file` JSON we use. */
export interface RenderSummary {
  geometry?: {
    facets?: number;
    vertices?: number;
    bounding_box?: { min: number[]; max: number[]; size: number[] };
  };
  time?: { total?: number };
}

export interface RenderResult {
  request: RenderRequest;
  /** True when OpenSCAD exited cleanly and wrote a mesh. */
  ok: boolean;
  /** True when the model evaluated to nothing ("Current top level object is empty."). */
  empty: boolean;
  model?: Uint8Array;
  summary?: RenderSummary;
  /** Every file the render read: the main file plus include/use/import targets. */
  deps: string[];
  /** Combined stdout and stderr. */
  output: string;
  exitCode: number | null;
  /** Wall-clock time including process startup. */
  ms: number;
}

export interface RenderRequest {
  exe: string;
  file: string;
  /** Extra command-line arguments, e.g. `-D name=value` overrides. */
  args?: string[];
  /** A quick low-detail render while a slider is being dragged. */
  draft?: boolean;
}

export interface RequestOptions {
  delayMs?: number;
  /**
   * true (default): kill any render in progress and start this one.
   * false: let the render in progress finish, then run only the newest waiting request. Used while
   * dragging, where killing every time the slider moves would mean nothing ever finishes.
   */
  interrupt?: boolean;
}

/**
 * Runs OpenSCAD for one file. Requests are debounced, and only the newest request's result is reported.
 */
export class RenderQueue {
  private timer?: NodeJS.Timeout;
  private child?: ChildProcess;
  private generation = 0;
  /** Generation of the render in progress, if any. */
  private activeGeneration?: number;
  private pending?: RenderRequest;
  private workDir?: Promise<string>;

  constructor(
    private readonly onStart: (request: RenderRequest) => void,
    private readonly onResult: (result: RenderResult) => void,
  ) {}

  request(req: RenderRequest, { delayMs = 300, interrupt = true }: RequestOptions = {}): void {
    clearTimeout(this.timer);
    if (!interrupt && this.activeGeneration !== undefined) {
      this.pending = req;
      return;
    }
    this.pending = undefined;
    this.timer = setTimeout(() => void this.run(req), delayMs);
  }

  /** Stop the render in progress and drop any waiting one; neither reports a result. */
  cancel(): void {
    clearTimeout(this.timer);
    this.pending = undefined;
    this.generation++;
    this.activeGeneration = undefined;
    this.kill();
  }

  /** A render is running (not just waiting out its delay). */
  get busy(): boolean {
    return this.activeGeneration !== undefined;
  }

  dispose(): void {
    this.cancel();
    void this.workDir?.then((dir) => fs.rm(dir, { recursive: true, force: true }));
  }

  private kill(): void {
    const child = this.child;
    this.child = undefined;
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    try {
      // Spawned detached, so the pid is also a process group: this stops the AppImage and anything it started.
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  }

  private async run(request: RenderRequest): Promise<void> {
    this.kill();
    const gen = ++this.generation;
    this.activeGeneration = gen;
    try {
      await this.execute(request, gen);
    } finally {
      if (this.activeGeneration === gen) {
        this.activeGeneration = undefined;
        const next = this.pending;
        this.pending = undefined;
        if (next && gen === this.generation) void this.run(next);
      }
    }
  }

  private async execute(request: RenderRequest, gen: number): Promise<void> {
    const { exe, file } = request;
    const dir = await (this.workDir ??= fs.mkdtemp(path.join(os.tmpdir(), 'scad-preview-')));
    if (gen !== this.generation) return;

    const modelFile = path.join(dir, `render-${gen}.3mf`);
    const summaryFile = path.join(dir, `render-${gen}.json`);
    const depsFile = path.join(dir, `render-${gen}.deps`);
    const args = [
      '--backend=manifold',
      // The default scheme exports faces cut by uncolored shapes in green; Monotone leaves them uncolored.
      '--colorscheme=Monotone',
      '-o', modelFile,
      '-d', depsFile,
      '--summary', 'all',
      '--summary-file', summaryFile,
      ...(request.args ?? []),
      file,
    ];

    this.onStart(request);
    const started = Date.now();
    const child = spawn(exe, args, { cwd: path.dirname(file), detached: true });
    this.child = child;
    let output = '';
    child.stdout.on('data', (d: Buffer) => (output += d.toString()));
    child.stderr.on('data', (d: Buffer) => (output += d.toString()));
    const exitCode = await new Promise<number | null>((resolve) => {
      child.on('error', (err) => {
        output += `${err.message}\n`;
        resolve(null);
      });
      child.on('close', (code) => resolve(code));
    });
    const ms = Date.now() - started;

    const [model, summaryText, depsText] = await Promise.all([
      readOptional(modelFile),
      readOptional(summaryFile),
      readOptional(depsFile),
    ]);
    await Promise.all([modelFile, summaryFile, depsFile].map((f) => fs.rm(f, { force: true })));
    if (gen !== this.generation) return;
    if (this.child === child) this.child = undefined;

    let summary: RenderSummary | undefined;
    try {
      summary = summaryText ? (JSON.parse(Buffer.from(summaryText).toString()) as RenderSummary) : undefined;
    } catch {
      summary = undefined;
    }
    this.onResult({
      request,
      ok: exitCode === 0 && model !== undefined,
      empty: /Current top level object is empty/.test(output),
      model,
      summary,
      deps: depsText ? parseDepsFile(Buffer.from(depsText).toString()) : [],
      output,
      exitCode,
      ms,
    });
  }
}

async function readOptional(file: string): Promise<Uint8Array | undefined> {
  try {
    return new Uint8Array(await fs.readFile(file));
  } catch {
    return undefined;
  }
}
