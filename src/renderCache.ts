import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import type { DebugParts } from './debugPass';
import type { RenderResult } from './renderer';

export interface CachedRender {
  /** Everything about the result except which request asked for it. */
  result: Omit<RenderResult, 'request'>;
  /** The `#` / `%` parts, once their pass has finished for this result. */
  debug?: DebugParts;
}

/**
 * Finished renders, so going back to earlier slider values (or undoing an edit) shows the model at
 * once. Shared by all panels; least recently used entries go first once over `maxBytes`.
 *
 * A key covers the program, the arguments (the `-D` values) and the contents of the files involved.
 * Entries are stored under the files the render actually read (its deps), and looked up with the
 * deps of the panel's previous render, so a changed include or library file never gives a stale hit.
 */
export class RenderCache {
  private readonly entries = new Map<string, CachedRender>();
  private bytes = 0;
  /** File hashes, reused while a file's size and modification time are unchanged. */
  private readonly fileHashes = new Map<string, { size: number; mtimeMs: number; hash: string }>();

  constructor(private readonly maxBytes = 256 * 1024 * 1024) {}

  async key(exe: string, args: string[], files: Iterable<string>): Promise<string> {
    const sorted = [...new Set(files)].sort();
    const hashes = await Promise.all(sorted.map((f) => this.hashFile(f)));
    const h = createHash('sha256');
    h.update(JSON.stringify([exe, args]));
    sorted.forEach((f, i) => h.update(`\n${f}\n${hashes[i]}`));
    return h.digest('hex');
  }

  get(key: string): CachedRender | undefined {
    const entry = this.entries.get(key);
    if (entry) {
      // Most recently used goes to the end of the Map's order.
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    return entry;
  }

  set(key: string, result: RenderResult): void {
    const { request: _request, ...rest } = result;
    this.remove(key);
    const entry: CachedRender = { result: rest };
    this.entries.set(key, entry);
    this.bytes += sizeOf(entry);
    for (const [oldest] of this.entries) {
      if (this.bytes <= this.maxBytes || oldest === key) break;
      this.remove(oldest);
    }
  }

  setDebug(key: string, debug: DebugParts): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.bytes -= sizeOf(entry);
    entry.debug = debug;
    this.bytes += sizeOf(entry);
  }

  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.bytes -= sizeOf(entry);
    this.entries.delete(key);
  }

  private async hashFile(file: string): Promise<string> {
    try {
      const stat = await fs.stat(file);
      const known = this.fileHashes.get(file);
      if (known && known.size === stat.size && known.mtimeMs === stat.mtimeMs) return known.hash;
      const hash = createHash('sha256').update(await fs.readFile(file)).digest('hex');
      this.fileHashes.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, hash });
      return hash;
    } catch {
      return 'missing';
    }
  }
}

function sizeOf(entry: CachedRender): number {
  const { model, output } = entry.result;
  return (model?.length ?? 0) + output.length * 2 + (entry.debug?.highlight?.length ?? 0) + (entry.debug?.background?.length ?? 0) + 1024;
}
