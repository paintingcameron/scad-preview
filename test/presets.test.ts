import { describe, expect, it } from 'vitest';
import type { ParamDef } from '../src/customizer';
import { parsePresetFile, presetPath, presetToValues, serializePresetFile, valuesToPreset } from '../src/presets';

const defs: ParamDef[] = [
  { name: 'height', type: 'number', initial: 35, group: 'G', step: 1 },
  { name: 'labels', type: 'boolean', initial: true, group: 'G' },
  { name: 'font', type: 'string', initial: 'Liberation Sans', group: 'G' },
  { name: 'size', type: 'number', initial: [1, 2], group: 'G' },
];

// Same shape as trainer-v2.json, written by the OpenSCAD GUI.
const gui = `{
  "parameterSets": {
    "ps1": { "height": "32.5", "labels": "false", "font": "DejaVu Sans", "size": "[3, 4]", "removed_param": "1" },
    "ps2": { "height": "35", "labels": "maybe", "size": "oops" }
  },
  "fileFormatVersion": "1"
}`;

describe('presets', () => {
  it('lives next to the model with a .json extension', () => {
    expect(presetPath('/a/b/trainer-v2.scad')).toBe('/a/b/trainer-v2.json');
  });

  it('reads GUI presets into typed overrides', () => {
    const file = parsePresetFile(gui);
    expect(presetToValues(file.parameterSets.ps1, defs)).toEqual({
      height: 32.5,
      labels: false,
      font: 'DejaVu Sans',
      size: [3, 4],
    });
  });

  it('skips defaults and values it cannot read', () => {
    expect(presetToValues(parsePresetFile(gui).parameterSets.ps2, defs)).toEqual({});
  });

  it('writes every parameter as a string, like the GUI', () => {
    expect(valuesToPreset({ height: 40 }, defs)).toEqual({
      height: '40',
      labels: 'true',
      font: 'Liberation Sans',
      size: '[1, 2]',
    });
  });

  it('round-trips and keeps unknown keys', () => {
    const file = parsePresetFile('{"parameterSets":{},"fileFormatVersion":"1","extra":42}');
    file.parameterSets.mine = valuesToPreset({ size: [5, 6] }, defs);
    const again = parsePresetFile(serializePresetFile(file));
    expect(again.extra).toBe(42);
    expect(presetToValues(again.parameterSets.mine, defs)).toEqual({ size: [5, 6] });
  });

  it('treats a missing or broken file as empty', () => {
    expect(parsePresetFile(undefined).parameterSets).toEqual({});
    expect(parsePresetFile('{not json').parameterSets).toEqual({});
  });
});
