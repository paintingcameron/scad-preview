import * as fs from 'node:fs/promises';
import * as path from 'node:path';

type Vec3 = [number, number, number];

export type MeasureKind = 'distance' | 'wall' | 'angle' | 'box';
const KINDS: readonly string[] = ['distance', 'wall', 'angle', 'box'];

/**
 * A measurement added in the preview (clicked or typed), as saved.
 * - distance, wall: from a to b. `kind` is left out for a distance.
 * - angle: at the corner b, between a and c.
 * - box: a is the low corner, b the high one; `diameter` when the outline it came from is round.
 */
export interface SavedMeasurement {
  kind?: Exclude<MeasureKind, 'distance'>;
  a: Vec3;
  b: Vec3;
  c?: Vec3;
  diameter?: number;
  label?: string;
  hidden?: boolean;
}

/**
 * A model's measurements: `.scad-preview/<model>.measure.json` in the model's folder, so they
 * travel with the project. Code measurements are rebuilt on every render; only the keys of the
 * ones the user hid are kept.
 */
export interface SavedMeasures {
  measurements: SavedMeasurement[];
  hiddenCode: string[];
}

export function measurePath(scadFile: string): string {
  return path.join(path.dirname(scadFile), '.scad-preview', `${path.basename(scadFile, '.scad')}.measure.json`);
}

export function isEmpty(saved: SavedMeasures): boolean {
  return saved.measurements.length === 0 && saved.hiddenCode.length === 0;
}

/** Parse a measure file, skipping anything malformed. A missing or unreadable file means none. */
export function parseMeasureFile(text: string | undefined): SavedMeasures {
  const saved: SavedMeasures = { measurements: [], hiddenCode: [] };
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    return saved;
  }
  if (!json || typeof json !== 'object') return saved;
  const { measurements, hiddenCode } = json as Record<string, unknown>;
  if (Array.isArray(measurements)) {
    for (const m of measurements) {
      if (!m || !isVec3(m.a) || !isVec3(m.b)) continue;
      if (m.kind !== undefined && !KINDS.includes(m.kind)) continue; // a kind this version doesn't know
      if (m.kind === 'angle' && !isVec3(m.c)) continue;
      const entry: SavedMeasurement = { a: m.a, b: m.b };
      if (m.kind && m.kind !== 'distance') entry.kind = m.kind;
      if (m.kind === 'angle') entry.c = m.c;
      if (m.kind === 'box' && typeof m.diameter === 'number' && Number.isFinite(m.diameter)) entry.diameter = m.diameter;
      if (typeof m.label === 'string' && m.label) entry.label = m.label;
      if (m.hidden === true) entry.hidden = true;
      saved.measurements.push(entry);
    }
  }
  if (Array.isArray(hiddenCode)) saved.hiddenCode = hiddenCode.filter((k): k is string => typeof k === 'string');
  return saved;
}

export function serializeMeasureFile(saved: SavedMeasures): string {
  return `${JSON.stringify({ version: 1, ...saved }, null, 2)}\n`;
}

export async function loadMeasures(scadFile: string): Promise<SavedMeasures> {
  try {
    return parseMeasureFile(await fs.readFile(measurePath(scadFile), 'utf8'));
  } catch {
    return parseMeasureFile(undefined);
  }
}

/**
 * Write the file, creating the folder on first use. Nothing to save removes the file, and the
 * folder too once it is empty, so models without measurements leave nothing behind.
 */
export async function saveMeasures(scadFile: string, saved: SavedMeasures): Promise<void> {
  const file = measurePath(scadFile);
  if (isEmpty(saved)) {
    await fs.rm(file, { force: true });
    await fs.rmdir(path.dirname(file)).catch(() => undefined); // not empty, or already gone
    return;
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, serializeMeasureFile(saved), 'utf8');
}

function isVec3(v: unknown): v is Vec3 {
  return Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n));
}
