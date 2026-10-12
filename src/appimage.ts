import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** Unpacks in progress, so two panels opening at once share one. */
const unpacking = new Map<string, Promise<string | undefined>>();

/**
 * The program inside an AppImage, unpacked once into `storageDir`. Starting an AppImage mounts it
 * first, which costs ~0.3 s per run (measured 0.36 s vs 0.06 s on a small model); the unpacked copy
 * starts straight away. Unpacking takes ~1 s and ~300 MB, and is redone when the AppImage changes;
 * copies of older AppImages are removed. Undefined when unpacking fails: use the AppImage itself.
 */
export async function unpackedAppImage(appImage: string, storageDir: string): Promise<string | undefined> {
  let stat;
  try {
    stat = await fs.stat(appImage);
  } catch {
    return undefined;
  }
  const id = createHash('sha1').update(`${path.resolve(appImage)}|${stat.size}|${stat.mtimeMs}`).digest('hex').slice(0, 12);
  const root = path.join(storageDir, 'appimage');
  const program = path.join(root, id, 'squashfs-root', 'AppRun');
  if (await exists(program)) return program;

  let job = unpacking.get(id);
  if (!job) {
    job = unpack(appImage, root, id).finally(() => unpacking.delete(id));
    unpacking.set(id, job);
  }
  return job;
}

async function unpack(appImage: string, root: string, id: string): Promise<string | undefined> {
  // Unpack beside the final folder and rename, so a half-written copy is never used.
  const temp = path.join(root, `${id}.partial-${process.pid}`);
  const final = path.join(root, id);
  try {
    await fs.rm(temp, { recursive: true, force: true });
    await fs.mkdir(temp, { recursive: true });
    const code = await new Promise<number | null>((resolve) => {
      const child = spawn(appImage, ['--appimage-extract'], { cwd: temp, stdio: 'ignore' });
      child.on('error', () => resolve(null));
      child.on('close', resolve);
    });
    if (code !== 0 || !(await exists(path.join(temp, 'squashfs-root', 'AppRun')))) throw new Error(`exit ${code}`);
    await fs.rm(final, { recursive: true, force: true });
    await fs.rename(temp, final);
    // Unpacked copies of other (older) AppImages: ~300 MB each.
    for (const entry of await fs.readdir(root)) {
      if (entry !== id && !entry.includes('.partial-')) await fs.rm(path.join(root, entry), { recursive: true, force: true });
    }
    return path.join(final, 'squashfs-root', 'AppRun');
  } catch {
    await fs.rm(temp, { recursive: true, force: true }).catch(() => undefined);
    return undefined;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}
