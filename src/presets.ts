import * as path from 'node:path';
import { valuesEqual, type ParamDef, type ParamValue } from './customizer';

/**
 * OpenSCAD's parameter-set file: `<model>.json` next to `<model>.scad`. Every value is stored as a
 * string ("3.5", "true", "[1, 2]", or raw text for strings), so presets saved here open in the GUI.
 */
export interface PresetFile {
  parameterSets: Record<string, Record<string, string>>;
  fileFormatVersion: string;
  [other: string]: unknown;
}

export function presetPath(scadFile: string): string {
  return path.join(path.dirname(scadFile), `${path.basename(scadFile, '.scad')}.json`);
}

/** Parse a preset file, tolerating a missing or malformed one as "no presets". */
export function parsePresetFile(text: string | undefined): PresetFile {
  try {
    const json = text ? JSON.parse(text) : {};
    const sets = json && typeof json.parameterSets === 'object' && json.parameterSets ? json.parameterSets : {};
    return { ...json, parameterSets: sets, fileFormatVersion: String(json.fileFormatVersion ?? '1') };
  } catch {
    return { parameterSets: {}, fileFormatVersion: '1' };
  }
}

export function serializePresetFile(file: PresetFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** Overrides (values that differ from the defaults) described by a preset. Unknown or unreadable entries are skipped. */
export function presetToValues(set: Record<string, string>, defs: ParamDef[]): Record<string, ParamValue> {
  const values: Record<string, ParamValue> = {};
  for (const def of defs) {
    const raw = set[def.name];
    if (raw === undefined) continue;
    const value = fromPresetString(def, String(raw));
    if (value !== undefined && !valuesEqual(value, def.initial)) values[def.name] = value;
  }
  return values;
}

/** A preset holding every parameter's current value, as the OpenSCAD GUI writes them. */
export function valuesToPreset(values: Record<string, ParamValue>, defs: ParamDef[]): Record<string, string> {
  const set: Record<string, string> = {};
  for (const def of defs) set[def.name] = toPresetString(values[def.name] ?? def.initial);
  return set;
}

export function toPresetString(value: ParamValue): string {
  if (Array.isArray(value)) return `[${value.join(', ')}]`;
  return String(value);
}

export function fromPresetString(def: ParamDef, raw: string): ParamValue | undefined {
  if (def.type === 'boolean') return raw === 'true' ? true : raw === 'false' ? false : undefined;
  if (def.type === 'string') return raw;
  if (Array.isArray(def.initial)) {
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) && parsed.every((n) => typeof n === 'number') ? (parsed as number[]) : undefined;
    } catch {
      return undefined;
    }
  }
  const n = Number(raw);
  return raw.trim() !== '' && Number.isFinite(n) ? n : undefined;
}
